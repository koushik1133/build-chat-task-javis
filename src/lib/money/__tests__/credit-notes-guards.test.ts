import { beforeEach, describe, expect, it, vi } from "vitest";

/** SEC: credit notes and refunds must stay inside the org and inside the invoice's totals. */
const db = vi.hoisted(() => ({
  query: vi.fn<(sql: string, values?: unknown[]) => Promise<unknown[]>>(async () => []),
  queryOne: vi.fn<(sql: string, values?: unknown[]) => Promise<unknown>>(async () => null),
  withRetry: vi.fn(async <T,>(fn: () => Promise<T>) => fn()),
}));
vi.mock("@/lib/dsql", () => db);
vi.mock("@/lib/table-exists", () => ({ tableExists: vi.fn(async () => true) }));
vi.mock("@/lib/docs/numbering", () => ({ nextDocNumber: vi.fn(async () => "CN-1") }));
vi.mock("@/lib/events/bus", () => ({ emitEvent: vi.fn(async () => undefined) }));
const refund = vi.hoisted(() => vi.fn(async () => ({ refundRef: "re_1" })));
vi.mock("@/lib/payments", () => ({ getProvider: () => ({ refund }) }));
vi.mock("@/lib/money/settings", () => ({ getBillingSettings: vi.fn(async () => ({ credit_note_prefix: "CN", prices_include_tax: false, tax_rounding: "per_line" })) }));
vi.mock("@/lib/money/tax-rates", () => ({ resolveDocumentTotals: vi.fn(async (_d: string, items: Array<{ unit_price_minor: number; quantity: number }>) => { const t = items.reduce((a, i) => a + i.unit_price_minor * i.quantity, 0); return { subtotal_minor: t, tax_minor: 0, total_minor: t, breakdown: [] }; }) }));

const invoices = vi.hoisted(() => ({
  getInvoice: vi.fn<(d: string, id: string) => Promise<unknown>>(async () => null),
  listPayments: vi.fn<(id: string) => Promise<unknown[]>>(async () => []),
  recomputeInvoiceStatus: vi.fn(async () => "paid"),
}));
vi.mock("@/lib/money/invoices", () => invoices);

import { createCreditNote, issueCreditNote, refundPayment } from "@/lib/money/credit-notes";

const item = { description: "Work", quantity: 1, unit_price_minor: 300 };
const inv = { id: "inv1", number: "INV-1", status: "sent", items: [item], contact_id: "c-own", currency: "USD", total_minor: 1000 };

function cnRow(over: Record<string, unknown> = {}) {
  return { id: "cn1", invoice_id: "inv1", invoice_number: "INV-1", contact_id: "c-own", contact_name: "Own", contact_email: null, number: "CN-1", items: JSON.stringify([item]), subtotal_minor: 300, tax_minor: 0, total_minor: 300, tax_breakdown: "[]", currency: "USD", reason: null, status: "draft", issued_at: null, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", ...over };
}

describe("credit note guards", () => {
  beforeEach(() => {
    db.query.mockReset();
    db.queryOne.mockReset();
    invoices.getInvoice.mockReset();
    invoices.listPayments.mockReset();
    refund.mockClear();
  });

  it("rejects a contact from another org even when an invoice is referenced", async () => {
    invoices.getInvoice.mockResolvedValue(inv);
    db.queryOne.mockResolvedValueOnce(null); // SELECT id FROM crm_contacts … user_id = org1 → none
    await expect(createCreditNote("org1", { invoice_id: "inv1", contact_id: "c-foreign" })).rejects.toThrow(/Contact not found/);
    expect(db.queryOne.mock.calls[0][0]).toMatch(/FROM crm_contacts WHERE id = \$1 AND user_id = \$2/);
    expect(db.queryOne.mock.calls[0][1]).toEqual(["c-foreign", "org1"]);
    expect(db.query.mock.calls.filter(([sql]) => /INSERT INTO credit_notes/.test(sql))).toHaveLength(0);
  });

  it("re-checks the invoice cap when issuing a draft (several drafts cannot each pass create-time)", async () => {
    db.queryOne.mockResolvedValueOnce(cnRow()); // getCreditNote
    invoices.getInvoice.mockResolvedValue(inv);
    db.queryOne.mockResolvedValueOnce({ total: "800" }); // creditedAgainstInvoice (excluding cn1)
    await expect(issueCreditNote("org1", "cn1")).rejects.toThrow(/exceeds the invoice total/);
    expect(db.query.mock.calls.filter(([sql]) => /UPDATE credit_notes SET status/.test(sql))).toHaveLength(0);
    const sumCall = db.queryOne.mock.calls[1];
    expect(sumCall[0]).toMatch(/user_id = \$2/);
    expect(sumCall[1]).toEqual(["inv1", "org1", "cn1"]);
  });

  it("issues when the remaining headroom covers the note", async () => {
    db.queryOne.mockResolvedValueOnce(cnRow());
    invoices.getInvoice.mockResolvedValue(inv);
    db.queryOne.mockResolvedValueOnce({ total: "700" });
    db.query.mockResolvedValueOnce([{ id: "cn1" }]); // flip
    db.queryOne.mockResolvedValueOnce(cnRow({ status: "applied" }));
    await expect(issueCreditNote("org1", "cn1")).resolves.toMatchObject({ status: "applied" });
  });

  it("refund: credit note must belong to the same invoice and cap the amount", async () => {
    invoices.getInvoice.mockResolvedValue(inv);
    const payment = { id: "p1", provider: "simulated", provider_ref: "pi_1", amount_minor: 1000, currency: "USD", status: "succeeded", refunded_minor: 0 };
    invoices.listPayments.mockResolvedValue([payment]);
    db.queryOne.mockResolvedValueOnce(cnRow({ status: "applied", invoice_id: "inv-other" }));
    await expect(refundPayment("org1", "inv1", { paymentId: "p1", amount_minor: 100, credit_note_id: "cn1" })).rejects.toThrow(/different invoice/);
    db.queryOne.mockResolvedValueOnce(cnRow({ status: "applied", total_minor: 300 }));
    await expect(refundPayment("org1", "inv1", { paymentId: "p1", amount_minor: 500, credit_note_id: "cn1" })).rejects.toThrow(/exceeds the credit note total/);
    expect(refund).not.toHaveBeenCalled();
  });

  it("refund: never more than the payment's refundable remainder", async () => {
    invoices.getInvoice.mockResolvedValue(inv);
    invoices.listPayments.mockResolvedValue([{ id: "p1", provider: "simulated", provider_ref: "pi_1", amount_minor: 1000, currency: "USD", status: "succeeded", refunded_minor: 900 }]);
    await expect(refundPayment("org1", "inv1", { paymentId: "p1", amount_minor: 101 })).rejects.toThrow(/exceeds the refundable amount/);
    expect(refund).not.toHaveBeenCalled();
  });

  it("refund: claims the amount on the payment row before the provider moves money", async () => {
    invoices.getInvoice.mockResolvedValue(inv);
    const payment = { id: "p1", provider: "simulated", provider_ref: "pi_1", amount_minor: 1000, currency: "USD", status: "succeeded", refunded_minor: 100 };
    invoices.listPayments.mockResolvedValue([payment]);
    db.query.mockResolvedValueOnce([{ id: "p1" }]); // claim
    db.query.mockResolvedValueOnce([]); // refund_ref
    const out = await refundPayment("org1", "inv1", { paymentId: "p1", amount_minor: 200 });
    expect(out.refund_ref).toBe("re_1");
    const [claimSql, claimParams] = db.query.mock.calls[0];
    expect(claimSql).toMatch(/SET refunded_minor = COALESCE\(refunded_minor, 0\) \+ \$2/);
    expect(claimSql).toMatch(/COALESCE\(refunded_minor, 0\) = \$3/);
    expect(claimParams).toEqual(["p1", 200, 100]);
    expect(db.query.mock.invocationCallOrder[0]).toBeLessThan(refund.mock.invocationCallOrder[0]);
    expect(db.query.mock.calls[1][0]).toMatch(/SET refund_ref = \$2/);
    expect(db.query.mock.calls[1][1]).toEqual(["p1", "re_1"]);
  });

  it("refund: a lost claim race never reaches the provider", async () => {
    invoices.getInvoice.mockResolvedValue(inv);
    invoices.listPayments.mockResolvedValue([{ id: "p1", provider: "simulated", provider_ref: "pi_1", amount_minor: 1000, currency: "USD", status: "succeeded", refunded_minor: 0 }]);
    db.query.mockResolvedValueOnce([]); // claim matched 0 rows
    await expect(refundPayment("org1", "inv1", { paymentId: "p1", amount_minor: 200 })).rejects.toThrow(/Payment changed while refunding/);
    expect(refund).not.toHaveBeenCalled();
  });

  it("refund: a provider failure releases the claim so the amount stays refundable", async () => {
    invoices.getInvoice.mockResolvedValue(inv);
    invoices.listPayments.mockResolvedValue([{ id: "p1", provider: "stripe", provider_ref: "cs_1", amount_minor: 1000, currency: "USD", status: "succeeded", refunded_minor: 100 }]);
    db.query.mockResolvedValueOnce([{ id: "p1" }]); // claim
    refund.mockRejectedValueOnce(new Error("Stripe refunds are not wired yet"));
    db.query.mockResolvedValueOnce([{ id: "p1" }]); // release
    await expect(refundPayment("org1", "inv1", { paymentId: "p1", amount_minor: 200 })).rejects.toThrow(/not wired/);
    const [releaseSql, releaseParams] = db.query.mock.calls[1];
    expect(releaseSql).toMatch(/SET refunded_minor = COALESCE\(refunded_minor, 0\) - \$2/);
    expect(releaseParams).toEqual(["p1", 200, 300]);
    expect(db.query.mock.calls.some(([sql]) => /credit_notes SET status = 'refunded'/.test(sql))).toBe(false);
  });

  it("rejects a credit note in a different currency than the invoice", async () => {
    invoices.getInvoice.mockResolvedValue(inv);
    await expect(createCreditNote("org1", { invoice_id: "inv1", currency: "EUR" })).rejects.toThrow(/currency EUR does not match invoice currency USD/);
    expect(db.query.mock.calls.filter(([sql]) => /INSERT INTO credit_notes/.test(sql))).toHaveLength(0);
  });
});
