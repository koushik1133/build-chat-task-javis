import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * invoice_payments carries a unique (invoice_id, provider, provider_ref) index, and
 * createPayLink pre-writes a `pending` row with the provider ref. A later provider
 * event must promote that row, never insert a sibling, and a provider object that
 * already succeeded is never counted twice.
 */
const query = vi.fn();
const queryOne = vi.fn();
vi.mock("@/lib/dsql", () => ({
  query: (...args: unknown[]) => query(...args),
  queryOne: (...args: unknown[]) => queryOne(...args),
  withRetry: (fn: () => unknown) => fn(),
  isUndefinedColumn: () => false,
}));
vi.mock("@/lib/inventory/stock", () => ({ consumeForInvoice: vi.fn(async () => []) }));
vi.mock("@/lib/docs/numbering", () => ({ nextDocNumber: vi.fn() }));
vi.mock("@/lib/share-tokens", () => ({ issueShareToken: vi.fn() }));
vi.mock("@/lib/notifications/outbox", () => ({ enqueueNotification: vi.fn() }));
vi.mock("@/lib/payments", () => ({ getProvider: vi.fn() }));
vi.mock("@/lib/events/bus", () => ({ emitEvent: vi.fn(async () => undefined), EVENT_TYPES: [] }));

import { recordPayment } from "@/lib/money/invoices";

const invoice = {
  id: "inv1", user_id: "org", contact_id: null, quote_id: null, number: "INV-1", status: "sent", currency: "USD", subtotal_minor: "1000", tax_minor: "0",
  total_minor: "1000", paid_minor: "0", due_at: null, items: "[]", notes: null, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", sent_at: null, paid_at: null,
};

function setup(existing: { id: string; status: string } | null) {
  queryOne.mockImplementation(async (sql: string) => {
    if (sql.includes("FROM invoices")) return invoice;
    if (sql.includes("FROM invoice_payments WHERE invoice_id = $1 AND provider = $2 AND provider_ref = $3")) return existing;
    if (sql.includes("SUM(amount_minor")) return { paid: "1000" };
    return null;
  });
}

beforeEach(() => {
  query.mockReset().mockResolvedValue([]);
  queryOne.mockReset();
});

describe("recordPayment with a provider_ref", () => {
  it("promotes the pending pay-link row in place instead of inserting a second row", async () => {
    setup({ id: "pay-pending", status: "pending" });
    query.mockImplementation(async (sql: string) => (sql.includes("UPDATE invoice_payments SET status") ? [{ id: "pay-pending" }] : []));
    const r = await recordPayment({ invoiceId: "inv1", provider: "simulated", providerRef: "sim_abc", amountMinor: 1000, currency: "usd" });
    expect(r).toEqual({ status: "paid", duplicate: false });
    const sqls = query.mock.calls.map((c) => String(c[0]));
    expect(sqls.some((s) => s.includes("INSERT INTO invoice_payments"))).toBe(false);
    const upd = query.mock.calls.find((c) => String(c[0]).includes("UPDATE invoice_payments SET status"));
    expect(upd?.[1]).toEqual(["pay-pending", "succeeded", 1000, "USD"]);
    expect(String(upd?.[0])).toMatch(/status <> 'succeeded'/);
  });

  it("treats a second success for the same provider object as a duplicate", async () => {
    setup({ id: "pay-done", status: "succeeded" });
    const r = await recordPayment({ invoiceId: "inv1", provider: "simulated", providerRef: "sim_abc", amountMinor: 1000, currency: "USD" });
    expect(r).toEqual({ status: "sent", duplicate: true });
    expect(query).not.toHaveBeenCalled();
  });

  it("never downgrades a succeeded row when a late failure event arrives", async () => {
    setup({ id: "pay-done", status: "succeeded" });
    const r = await recordPayment({ invoiceId: "inv1", provider: "simulated", providerRef: "sim_abc", amountMinor: 1000, currency: "USD", status: "failed" });
    expect(r.duplicate).toBe(true);
    expect(query).not.toHaveBeenCalled();
  });

  it("inserts when the ref is unknown, and folds a lost unique-index race into a duplicate", async () => {
    setup(null);
    const r = await recordPayment({ invoiceId: "inv1", provider: "simulated", providerRef: "sim_new", amountMinor: 1000, currency: "USD" });
    expect(r).toEqual({ status: "paid", duplicate: false });
    expect(String(query.mock.calls[0][0])).toMatch(/INSERT INTO invoice_payments/);

    query.mockReset();
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("INSERT INTO invoice_payments")) throw Object.assign(new Error("duplicate key"), { code: "23505" });
      return [];
    });
    const raced = await recordPayment({ invoiceId: "inv1", provider: "simulated", providerRef: "sim_new", amountMinor: 1000, currency: "USD" });
    expect(raced).toEqual({ status: "sent", duplicate: true });
  });
});
