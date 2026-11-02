import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.fn();
const queryOne = vi.fn();
vi.mock("@/lib/dsql", () => ({
  query: (...args: unknown[]) => query(...args),
  queryOne: (...args: unknown[]) => queryOne(...args),
}));
vi.mock("@/lib/events/bus", () => ({ emitEvent: vi.fn().mockResolvedValue(undefined) }));
const twilioIsLive = vi.fn(() => false);
vi.mock("@/lib/notifications/status", () => ({ twilioIsLive: () => twilioIsLive() }));
const recordOptOut = vi.fn();
vi.mock("@/lib/voice/campaigns", () => ({ recordOptOut: (...a: unknown[]) => recordOptOut(...a) }));

import { claimAttempt, completeTarget, dialNext } from "@/lib/voice/dialer";

const campaign = {
  id: "c1", user_id: "u1", name: "n", script: "Hello {{first_name}}", voice: "alice", status: "running", schedule_at: null,
  window_start: "00:00", window_end: "23:59", timezone: "UTC", max_attempts: 2, created_by: null, created_at: "", updated_at: "",
};
const target = { id: "t1", user_id: "u1", campaign_id: "c1", contact_id: "k1", phone: "+15550001", first_name: "Ana", status: "queued", attempts: 0, last_attempt_at: null, call_sid: null, outcome: null, created_at: "" };

beforeEach(() => {
  query.mockReset().mockResolvedValue([]);
  queryOne.mockReset().mockResolvedValue(null);
  recordOptOut.mockReset().mockResolvedValue("o1");
  twilioIsLive.mockReturnValue(false);
});

describe("claimAttempt", () => {
  it("is a conditional UPDATE on the retryable statuses and the attempt budget", async () => {
    queryOne.mockResolvedValueOnce({ id: "t1" });
    expect(await claimAttempt({ id: "t1" }, 3)).toBe(true);
    const [sql, params] = queryOne.mock.calls[0];
    expect(sql).toContain("status IN ('queued','no_answer','voicemail','failed')");
    expect(sql).toContain("attempts < $2");
    expect(sql).toContain("attempts = attempts + 1");
    expect(params).toEqual(["t1", 3]);
    queryOne.mockResolvedValueOnce(null);
    expect(await claimAttempt({ id: "t1" }, 3)).toBe(false);
  });
});

describe("dialNext", () => {
  it("skips a target another worker claimed first (no call, no voice_calls row)", async () => {
    // Monday 10:00 UTC, window open.
    const now = new Date("2025-06-02T10:00:00Z");
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM voice_campaigns")) return [campaign];
      if (sql.includes("FROM voice_campaign_targets")) return [target];
      return [];
    });
    queryOne.mockImplementation(async (sql: string) => {
      if (sql.startsWith("UPDATE voice_campaign_targets SET status = 'calling'")) return null; // lost the claim
      if (sql.includes("FROM voice_campaigns WHERE id = $1 AND user_id = $2")) return { id: "c1", status: "running", max_attempts: 2 };
      if (sql.includes("COUNT(*)")) return { n: 1 };
      return null;
    });
    const out = await dialNext(5, now);
    expect(out.dialed + out.simulated + out.failed).toBe(0);
    expect(query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO voice_calls"))).toBe(false);
  });

  it("claims before dialling and only then records the simulated call", async () => {
    const now = new Date("2025-06-02T10:00:00Z");
    const order: string[] = [];
    query.mockImplementation(async (sql: string) => {
      order.push(sql.slice(0, 40));
      if (sql.includes("FROM voice_campaigns")) return [campaign];
      if (sql.includes("FROM voice_campaign_targets")) return [target];
      return [];
    });
    queryOne.mockImplementation(async (sql: string) => {
      order.push(sql.slice(0, 40));
      if (sql.startsWith("UPDATE voice_campaign_targets SET status = 'calling'")) return { id: "t1" };
      if (sql.startsWith("INSERT INTO voice_calls")) return { id: "call1" };
      if (sql.includes("FROM voice_campaigns WHERE id = $1 AND user_id = $2")) return { id: "c1", status: "running", max_attempts: 2 };
      if (sql.includes("COUNT(*)")) return { n: 1 };
      return null;
    });
    const out = await dialNext(5, now);
    expect(out.simulated).toBe(1);
    const claimIdx = order.findIndex((s) => s.startsWith("UPDATE voice_campaign_targets SET status"));
    const callIdx = order.findIndex((s) => s.startsWith("INSERT INTO voice_calls"));
    expect(claimIdx).toBeGreaterThanOrEqual(0);
    expect(claimIdx).toBeLessThan(callIdx);
  });
});

describe("completeTarget", () => {
  it("never writes a real opt-out from a simulated outcome", async () => {
    await completeTarget(target, { status: "opted_out", callStatus: "completed", callSid: "SIM1", simulated: true, outcome: { digits: "2" } });
    expect(recordOptOut).not.toHaveBeenCalled();
    const [, params] = query.mock.calls[0];
    expect(JSON.parse(String(params[1])).simulated).toBe(true);
  });

  it("records a real opt-out for a live call", async () => {
    await completeTarget(target, { status: "opted_out", callStatus: "completed", callSid: "CA1", outcome: { digits: "2" } });
    expect(recordOptOut).toHaveBeenCalledWith("u1", expect.objectContaining({ phone: "+15550001", contact_id: "k1", channel: "voice" }));
  });
});
