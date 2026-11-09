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
vi.mock("@/lib/webhooks/dispatch", () => ({ fanOutNewEvents: vi.fn(async () => ({ scanned: 0, created: 0 })), deliverPending: vi.fn(async () => ({ claimed: 0, delivered: 0, failed: 0, dead: 0 })) }));
vi.mock("@/lib/money/quotes", () => ({ expireQuotes: vi.fn(async () => ({ scanned: 0, expired: 0, released: 0 })) }));
vi.mock("@/lib/mail/sync", () => ({ syncDueAccounts: vi.fn(async () => ({ claimed: 0 })) }));
vi.mock("@/lib/voice/dialer", () => ({ dialNext: vi.fn(async () => ({ dialed: 0 })) }));
vi.mock("@/lib/request-limits", async (orig) => ({ ...(await orig<Record<string, unknown>>()), pruneRateLimits: vi.fn(async () => 0) }));
const state = vi.hoisted(() => ({ getSystemState: vi.fn(), setSystemState: vi.fn(async () => undefined), applyRetention: vi.fn(async () => ({ policies: 0, affected: {} })) }));
vi.mock("@/lib/system/state", () => ({ recordCronTick: vi.fn(async () => undefined), getSystemState: state.getSystemState, setSystemState: state.setSystemState }));
vi.mock("@/lib/errors/capture", () => ({ captureError: vi.fn(async () => null) }));
vi.mock("@/lib/accounting/sync", () => ({ processAccountingEvents: vi.fn(async () => ({ pushed: 0 })), pushDue: vi.fn(async () => ({ pushed: 0 })), pullDue: vi.fn(async () => ({ recorded: 0 })) }));
vi.mock("@/lib/privacy/dsr", () => ({ remindDueSoon: vi.fn(async () => ({ reminded: 0 })) }));
vi.mock("@/lib/privacy/retention", () => ({ applyRetention: state.applyRetention }));
vi.mock("@/lib/money/dunning", () => ({ markOverdue: vi.fn(async () => ({ marked: 0 })), sendReminders: vi.fn(async () => ({ sent: 0 })) }));
vi.mock("@/lib/money/recurring", () => ({ runDueSchedules: vi.fn(async () => ({ created: 0 })) }));
vi.mock("@/lib/vitals", () => ({ pruneVitals: vi.fn(async () => 0) }));
vi.mock("@/lib/reports/digest", () => ({ sendDueDigests: vi.fn(async () => ({ sent: 0 })), sendDueReportSchedules: vi.fn(async () => ({ sent: 0 })) }));
vi.mock("@/lib/documents/documents", () => ({ expireDocuments: vi.fn(async () => ({ expired: 0 })) }));
vi.mock("@/lib/attachments/store", () => ({ purgeDeletedAttachments: vi.fn(async () => ({ purged: 0 })) }));
vi.mock("@/lib/workforce/shifts", () => ({ remindUpcomingShifts: vi.fn(async () => ({ reminded: 0 })) }));
vi.mock("@/lib/calsync/sync", () => ({ processCalendarEvents: vi.fn(async () => ({ pushed: 0 })), syncDue: vi.fn(async () => ({ synced: 0 })) }));
vi.mock("@/lib/chatops/process", () => ({ processChatEvents: vi.fn(async () => ({ delivered: 0 })) }));
vi.mock("@/lib/memberships/billing", () => ({ billDue: vi.fn(async () => ({})), sweepExpiring: vi.fn(async () => ({})) }));
vi.mock("@/lib/shipping/tracking", () => ({ advanceSimulated: vi.fn(async () => ({})), syncTracking: vi.fn(async () => ({})) }));
vi.mock("@/lib/tax-compliance/reminders", () => ({ taxFilingReminders: vi.fn(async () => ({})) }));
vi.mock("@/lib/engagement/surveys", () => ({ processEngagementEvents: vi.fn(async () => ({})) }));
vi.mock("@/lib/engagement/loyalty", () => ({ expirePoints: vi.fn(async () => ({})) }));
vi.mock("@/lib/engagement/giftcards", () => ({ expireGiftCards: vi.fn(async () => ({})) }));
vi.mock("@/lib/plans/cron", () => ({ renewDue: vi.fn(async () => ({ renewed: 0 })), grantMonthlyCredits: vi.fn(async () => ({ granted: 0 })) }));
vi.mock("@/lib/alerts/process", () => ({ processAlerts: vi.fn(async () => ({ evaluated: 0 })) }));
vi.mock("@/lib/projects/overdue", () => ({ markOverdueTasks: vi.fn(async () => ({ notified: 0 })) }));
vi.mock("@/lib/storefront/cart", () => ({ abandonedCartSweep: vi.fn(async () => ({ emitted: 0 })) }));
vi.mock("@/lib/marketing/campaigns", () => ({ sendBatch: vi.fn(async () => ({ sent: 0 })), syncDeliveryStatuses: vi.fn(async () => ({ delivered: 0 })) }));
vi.mock("@/lib/marketing/sequences", () => ({ runDueEnrollments: vi.fn(async () => ({ sent: 0 })), enrollAudienceJoins: vi.fn(async () => ({ enrolled: 0 })) }));

import { GET } from "@/app/api/cron/agents/route";

const savedSecret = process.env.CRON_SECRET;

beforeEach(() => {
  process.env.CRON_SECRET = "s3cret";
  mocks.claimJobs.mockResolvedValue([]);
  mocks.promoteDueTriggers.mockResolvedValue({ promoted: 0 });
  mocks.drainOutbox.mockReset();
  mocks.runSlaSweep.mockReset();
  state.getSystemState.mockReset().mockResolvedValue(null);
  state.setSystemState.mockClear();
  state.applyRetention.mockClear();
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

describe("cron hourly gate", () => {
  it("runs retention when no hourly stamp exists and records the slot", async () => {
    const res = await tick();
    const body = (await res.json()) as { hourly_ran: number };
    expect(body.hourly_ran).toBe(1);
    expect(state.applyRetention).toHaveBeenCalledTimes(1);
    expect(state.setSystemState).toHaveBeenCalledWith("cron:agents:hourly_jobs", expect.objectContaining({ at: expect.any(String) }));
  });

  it("skips retention and reminders when the last hourly run was under an hour ago", async () => {
    state.getSystemState.mockResolvedValue({ value: { at: new Date(Date.now() - 10 * 60_000).toISOString() }, updatedAt: "" });
    const res = await tick();
    const body = (await res.json()) as { hourly_ran: number; retention: number };
    expect(body.hourly_ran).toBe(0);
    expect(state.applyRetention).not.toHaveBeenCalled();
    expect(state.setSystemState).not.toHaveBeenCalled();
  });

  it("runs again once the hour has elapsed, and falls back to running when the gate errors", async () => {
    state.getSystemState.mockResolvedValue({ value: { at: new Date(Date.now() - 61 * 60_000).toISOString() }, updatedAt: "" });
    expect(((await (await tick()).json()) as { hourly_ran: number }).hourly_ran).toBe(1);
    state.getSystemState.mockRejectedValue(new Error("system_state missing"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(((await (await tick()).json()) as { hourly_ran: number }).hourly_ran).toBe(1);
    warn.mockRestore();
  });
});
