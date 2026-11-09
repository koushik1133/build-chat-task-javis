import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Recurring schedules: the claim must be exact (millisecond-normalised
 * timestamps) and a failed run must hand the billing period back instead of
 * silently skipping it.
 */
const db = vi.hoisted(() => ({
  query: vi.fn<(sql: string, values?: unknown[]) => Promise<unknown[]>>(async () => []),
  queryOne: vi.fn<(sql: string, values?: unknown[]) => Promise<unknown>>(async () => null),
}));
vi.mock("@/lib/dsql", () => db);
vi.mock("@/lib/table-exists", () => ({ tableExists: vi.fn(async () => true) }));
vi.mock("@/lib/events/bus", () => ({ emitEvent: vi.fn(async () => undefined) }));
const invoices = vi.hoisted(() => ({
  createInvoice: vi.fn<(d: string, input: Record<string, unknown>) => Promise<{ id: string; number: string; total_minor: number; currency: string }>>(),
  sendInvoice: vi.fn(async () => ({})),
}));
vi.mock("@/lib/money/invoices", () => invoices);

import { createSchedule, normaliseInstant, runSchedule } from "@/lib/money/recurring";

const item = { description: "Retainer", qty: 1, unit_minor: 10_000, tax_rate_bp: 0 };

function row(over: Record<string, unknown> = {}) {
  return {
    id: "s1", user_id: "org1", contact_id: "c1", contact_name: "Acme", contact_email: "ap@acme.test", name: "Monthly retainer", items: JSON.stringify([item]),
    currency: "USD", interval: "monthly", interval_count: 1, day_of_month: 1, next_run_at: new Date("2026-03-01T09:00:00.000Z"), end_at: null, auto_send: false,
    terms_days: 14, notes: null, status: "active", last_invoice_id: null, last_run_at: null, run_count: 3, created_at: new Date("2026-01-01T00:00:00Z"), updated_at: new Date("2026-01-01T00:00:00Z"),
    ...over,
  };
}

describe("normaliseInstant", () => {
  it("truncates microseconds and offsets to a UTC millisecond ISO string", () => {
    expect(normaliseInstant("2026-12-01T09:00:00.123456Z")).toBe("2026-12-01T09:00:00.123Z");
    expect(normaliseInstant("2026-12-01T10:00:00+01:00")).toBe("2026-12-01T09:00:00.000Z");
  });
});

describe("runSchedule", () => {
  beforeEach(() => {
    db.query.mockReset();
    db.queryOne.mockReset();
    invoices.createInvoice.mockReset();
    invoices.sendInvoice.mockClear();
  });

  it("stores next_run_at / end_at normalised to milliseconds so the claim compares equal", async () => {
    db.queryOne.mockResolvedValueOnce({ id: "c1" }); // contact check
    db.query.mockResolvedValueOnce([]); // INSERT
    db.queryOne.mockResolvedValueOnce(row()); // getSchedule
    await createSchedule("org1", {
      name: "Monthly retainer", contact_id: "c1", items: [item], interval: "monthly", interval_count: 1, auto_send: false,
      next_run_at: "2026-03-01T09:00:00.123456Z", end_at: "2027-03-01T00:00:00.999999Z",
    });
    const insert = db.query.mock.calls.find(([sql]) => /INSERT INTO invoice_schedules/.test(sql));
    expect(insert).toBeTruthy();
    const params = insert?.[1] as unknown[];
    expect(params[9]).toBe("2026-03-01T09:00:00.123Z");
    expect(params[10]).toBe("2027-03-01T00:00:00.999Z");
  });

  it("releases the claim when invoice creation fails so the period is retried, not skipped", async () => {
    db.queryOne.mockResolvedValueOnce(row()); // getSchedule
    db.query.mockResolvedValueOnce([{ id: "s1" }]); // claim
    invoices.createInvoice.mockRejectedValueOnce(new Error("Contact not found"));
    db.query.mockResolvedValueOnce([{ id: "s1" }]); // release

    const out = await runSchedule("org1", "s1", { now: new Date("2026-03-01T10:00:00Z") });
    expect(out.invoice_id).toBeNull();
    expect(out.error).toMatch(/Contact not found/);
    expect(out.status).toBe("active");
    expect(out.next_run_at).toBe("2026-03-01T09:00:00.000Z");

    const [claimSql, claimParams] = db.query.mock.calls[0];
    expect(claimSql).toMatch(/UPDATE invoice_schedules SET next_run_at = \$3, status = \$4/);
    expect(claimParams).toEqual(["s1", "org1", "2026-04-01T09:00:00.000Z", "active", "2026-03-01T09:00:00.000Z"]);

    const [releaseSql, releaseParams] = db.query.mock.calls[1];
    expect(releaseSql).toMatch(/UPDATE invoice_schedules SET next_run_at = \$3, status = 'active'/);
    expect(releaseSql).toMatch(/next_run_at = \$4 AND status = \$5/);
    // Restores the original instant, conditional on our own advanced value still being there.
    expect(releaseParams).toEqual(["s1", "org1", "2026-03-01T09:00:00.000Z", "2026-04-01T09:00:00.000Z", "active"]);
    expect(db.query.mock.calls.some(([sql]) => /run_count = run_count \+ 1/.test(sql))).toBe(false);
  });

  it("keeps the advanced cadence when the invoice exists but auto-send fails", async () => {
    db.queryOne.mockResolvedValueOnce(row({ auto_send: true }));
    db.query.mockResolvedValueOnce([{ id: "s1" }]); // claim
    invoices.createInvoice.mockResolvedValueOnce({ id: "inv1", number: "INV-1", total_minor: 10_000, currency: "USD" });
    db.query.mockResolvedValueOnce([]); // run_count bump
    invoices.sendInvoice.mockRejectedValueOnce(new Error("mail down"));

    const out = await runSchedule("org1", "s1", { now: new Date("2026-03-01T10:00:00Z") });
    expect(out.invoice_id).toBe("inv1");
    expect(out.sent).toBe(false);
    expect(out.error).toMatch(/mail down/);
    expect(out.next_run_at).toBe("2026-04-01T09:00:00.000Z");
    expect(db.query.mock.calls.filter(([sql]) => /status = 'active', updated_at/.test(sql))).toHaveLength(0);
  });

  it("marks the schedule ended when the following run would pass end_at (and still bills this period)", async () => {
    db.queryOne.mockResolvedValueOnce(row({ end_at: new Date("2026-03-15T00:00:00Z") }));
    db.query.mockResolvedValueOnce([{ id: "s1" }]);
    invoices.createInvoice.mockResolvedValueOnce({ id: "inv2", number: "INV-2", total_minor: 10_000, currency: "USD" });
    db.query.mockResolvedValueOnce([]);
    const out = await runSchedule("org1", "s1", { now: new Date("2026-03-01T10:00:00Z") });
    expect(out.status).toBe("ended");
    expect(out.next_run_at).toBeNull();
    expect(db.query.mock.calls[0][1]?.[3]).toBe("ended");
  });
});
