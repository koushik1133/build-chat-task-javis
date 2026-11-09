import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Payment terms: a quote conversion must inherit the org's default terms
 * (due_at derived on send) instead of a hard-coded due date, and the send
 * email must quote the due date that the send itself just derived.
 */
const db = vi.hoisted(() => ({
  query: vi.fn<(sql: string, values?: unknown[]) => Promise<unknown[]>>(async () => []),
  queryOne: vi.fn<(sql: string, values?: unknown[]) => Promise<unknown>>(async () => null),
  withRetry: vi.fn(async <T,>(fn: () => Promise<T>) => fn()),
}));
vi.mock("@/lib/dsql", () => db);
vi.mock("@/lib/table-exists", () => ({ tableExists: vi.fn(async () => true) }));
vi.mock("@/lib/docs/numbering", () => ({ nextDocNumber: vi.fn(async () => "INV-7") }));
vi.mock("@/lib/events/bus", () => ({ emitEvent: vi.fn(async () => undefined) }));
vi.mock("@/lib/inventory/stock", () => ({ consumeForInvoice: vi.fn(async () => undefined) }));
vi.mock("@/lib/payments", () => ({ getProvider: () => ({}) }));
const outbox = vi.hoisted(() => ({ enqueueNotification: vi.fn(async () => undefined) }));
vi.mock("@/lib/notifications/outbox", () => outbox);
vi.mock("@/lib/share-tokens", () => ({ issueShareToken: vi.fn(async () => ({ token: "t", path: "/p/i/t", url: "https://app.test/p/i/t", expiresAt: "2026-12-31T00:00:00Z" })) }));
vi.mock("@/lib/money/settings", () => ({ getBillingSettings: vi.fn(async () => ({ invoice_prefix: "INV", default_terms_days: 21, prices_include_tax: false, tax_rounding: "per_line" })) }));
vi.mock("@/lib/money/tax-rates", () => ({ resolveDocumentTotals: vi.fn(async () => ({ subtotal_minor: 500, tax_minor: 0, total_minor: 500, breakdown: [] })) }));
const quotes = vi.hoisted(() => ({
  businessName: vi.fn(async () => "Acme"),
  getQuote: vi.fn<(d: string, id: string) => Promise<unknown>>(async () => null),
}));
vi.mock("@/lib/money/quotes", () => quotes);

import { createInvoiceFromQuote, sendInvoice } from "@/lib/money/invoices";

const item = { description: "Work", qty: 1, unit_minor: 500 };
const invRow = (over: Record<string, unknown> = {}) => ({
  id: "inv1", user_id: "org1", contact_id: "c1", quote_id: "q1", number: "INV-7", status: "draft", currency: "USD", subtotal_minor: "500", tax_minor: "0", total_minor: "500", paid_minor: "0",
  due_at: null, items: JSON.stringify([item]), notes: null, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", sent_at: null, paid_at: null, tax_breakdown: "[]", terms_days: 21,
  reminder_count: 0, last_reminder_at: null, schedule_id: null, contact_name: "Ada", contact_email: "ada@example.com", ...over,
});

beforeEach(() => {
  db.query.mockReset();
  db.queryOne.mockReset();
  outbox.enqueueNotification.mockClear();
});

describe("createInvoiceFromQuote", () => {
  it("leaves due_at empty and applies the org default terms when no due_days is given", async () => {
    db.queryOne.mockResolvedValueOnce(null); // no existing invoice for the quote
    quotes.getQuote.mockResolvedValueOnce({ id: "q1", contact_id: "c1", currency: "USD", items: [item], notes: null });
    db.queryOne.mockResolvedValueOnce({ id: "c1" }); // contact check
    db.query.mockResolvedValueOnce([]); // INSERT
    db.queryOne.mockResolvedValueOnce(invRow()); // getInvoice
    await createInvoiceFromQuote("org1", "q1");
    const insert = db.query.mock.calls.find(([sql]) => /INSERT INTO invoices/.test(sql));
    const params = insert?.[1] as unknown[];
    expect(params[9]).toBeNull(); // due_at
    expect(params[13]).toBe(21); // terms_days from settings
  });

  it("keeps an explicit due date when due_days is passed (terms stay unset)", async () => {
    db.queryOne.mockResolvedValueOnce(null);
    quotes.getQuote.mockResolvedValueOnce({ id: "q1", contact_id: null, currency: "USD", items: [item], notes: null });
    db.query.mockResolvedValueOnce([]);
    db.queryOne.mockResolvedValueOnce(invRow({ contact_id: null }));
    await createInvoiceFromQuote("org1", "q1", { due_days: 7 });
    const params = db.query.mock.calls.find(([sql]) => /INSERT INTO invoices/.test(sql))?.[1] as unknown[];
    expect(typeof params[9]).toBe("string");
    expect(params[13]).toBeNull();
  });
});

describe("sendInvoice", () => {
  it("quotes the due date derived by the send, not the pre-send (null) value", async () => {
    db.queryOne.mockResolvedValueOnce(invRow()); // getInvoice (draft, due_at null)
    db.query.mockResolvedValueOnce([]); // status/sent_at/due_at UPDATE
    // recomputeInvoiceStatus
    db.queryOne.mockResolvedValueOnce({ user_id: "org1", status: "sent", total_minor: "500", due_at: "2026-01-22T00:00:00Z", items: "[]", quote_id: "q1" });
    db.queryOne.mockResolvedValueOnce({ paid: "0" });
    db.query.mockResolvedValueOnce([]);
    db.queryOne.mockResolvedValueOnce(invRow({ status: "sent", sent_at: "2026-01-01T00:00:00Z", due_at: "2026-01-22T00:00:00Z" })); // re-read
    const out = await sendInvoice("org1", "inv1", {});
    expect(out.invoice.due_at).toBe("2026-01-22T00:00:00Z");
    const mail = (outbox.enqueueNotification.mock.calls[0] as unknown[])[1] as { body: string; recipient: string };
    expect(mail.recipient).toBe("ada@example.com");
    expect(mail.body).toMatch(new RegExp(`Due ${new Date("2026-01-22T00:00:00Z").toDateString()}`));
    const update = db.query.mock.calls[0][0];
    expect(update).toMatch(/due_at = COALESCE\(due_at, CASE WHEN terms_days IS NOT NULL THEN COALESCE\(sent_at, NOW\(\)\) \+ make_interval\(days => terms_days\) END\)/);
  });
});
