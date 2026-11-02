import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  drainOutbox: vi.fn(),
  runSlaSweep: vi.fn(),
  claimJobs: vi.fn(),
  promoteDueTriggers: vi.fn(),
}));

vi.mock("@/lib/agents/queue", () => ({
  claimJobs: mocks.claimJobs,
  completeJob: vi.fn(),
  failJob: vi.fn(),
  parsePayload: vi.fn(),
}));
vi.mock("@/lib/agents/runner", () => ({ executeRun: vi.fn(), resumeRun: vi.fn() }));
vi.mock("@/lib/agents/triggers", () => ({ promoteDueTriggers: mocks.promoteDueTriggers }));
vi.mock("@/lib/agents/tools", () => ({ ensureToolsLoaded: vi.fn() }));
vi.mock("@/lib/agents/playbooks", () => ({ runPlaybookDetectors: vi.fn(async () => ({ queued: 0 })) }));
vi.mock("@/lib/notifications/outbox", () => ({ drainOutbox: mocks.drainOutbox }));
vi.mock("@/lib/helpdesk/tickets", () => ({ runSlaSweep: mocks.runSlaSweep }));

import { GET } from "@/app/api/cron/agents/route";

const savedSecret = process.env.CRON_SECRET;

beforeEach(() => {
  process.env.CRON_SECRET = "s3cret";
  mocks.claimJobs.mockResolvedValue([]);
  mocks.promoteDueTriggers.mockResolvedValue({ promoted: 0 });
  mocks.drainOutbox.mockReset();
  mocks.runSlaSweep.mockReset();
});
afterEach(() => {
  if (savedSecret === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = savedSecret;
});

function tick() {
  return GET(new Request("http://localhost/api/cron/agents", { headers: { authorization: "Bearer s3cret" } }));
}

describe("cron tick resilience", () => {
  it("still runs the SLA sweep and returns ok when the outbox drain throws", async () => {
    mocks.drainOutbox.mockRejectedValue(new Error("outbox table missing"));
    mocks.runSlaSweep.mockResolvedValue({ scanned: 2, breachedFirstResponse: 1, breachedResolution: 1, escalated: 1 });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await tick();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; sla: number; outbox: number };
    expect(body.ok).toBe(true);
    expect(body.sla).toBe(2);
    expect(body.outbox).toBe(0);
    expect(mocks.runSlaSweep).toHaveBeenCalledWith(200);
    spy.mockRestore();
  });

  it("an SLA sweep failure does not break the tick either", async () => {
    mocks.drainOutbox.mockResolvedValue({ claimed: 3, sent: 1, simulated: 2, failed: 0 });
    mocks.runSlaSweep.mockRejectedValue(new Error("tickets table missing"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await tick();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; sla: number; outbox: number };
    expect(body).toMatchObject({ ok: true, outbox: 3, sla: 0 });
    spy.mockRestore();
  });
});
