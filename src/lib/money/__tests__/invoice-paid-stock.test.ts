import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.fn();
const queryOne = vi.fn();
vi.mock("@/lib/dsql", () => ({
  query: (...args: unknown[]) => query(...args),
  queryOne: (...args: unknown[]) => queryOne(...args),
  withRetry: (fn: () => unknown) => fn(),
}));
const consumeForInvoice = vi.fn();
vi.mock("@/lib/inventory/stock", () => ({ consumeForInvoice: (...a: unknown[]) => consumeForInvoice(...a) }));
vi.mock("@/lib/docs/numbering", () => ({ nextDocNumber: vi.fn() }));
vi.mock("@/lib/share-tokens", () => ({ issueShareToken: vi.fn() }));
vi.mock("@/lib/notifications/outbox", () => ({ enqueueNotification: vi.fn() }));
vi.mock("@/lib/payments", () => ({ getProvider: vi.fn() }));

import { recomputeInvoiceStatus } from "@/lib/money/invoices";

const items = JSON.stringify([{ description: "Widget", qty: 2, unit_minor: 500, tax_rate_bp: 0, product_id: "p1" }]);

function invoiceRow(status: string) {
  return { user_id: "org", status, total_minor: "1000", due_at: null, items, quote_id: "q1" };
}

beforeEach(() => {
  query.mockReset();
  queryOne.mockReset();
  consumeForInvoice.mockReset();
  query.mockResolvedValue([]);
});

describe("recomputeInvoiceStatus → stock consumption", () => {
  it("consumes tracked stock exactly when the invoice transitions to paid", async () => {
    queryOne.mockImplementation(async (sql: string) => (sql.includes("FROM invoices") ? invoiceRow("sent") : { paid: "1000" }));
    consumeForInvoice.mockResolvedValue([]);
    const status = await recomputeInvoiceStatus("inv1");
    expect(status).toBe("paid");
    expect(consumeForInvoice).toHaveBeenCalledTimes(1);
    expect(consumeForInvoice).toHaveBeenCalledWith(
      "org",
      "inv1",
      [{ description: "Widget", qty: 2, unit_minor: 500, tax_rate_bp: 0, product_id: "p1" }],
      { quoteId: "q1" }
    );
  });

  it("does not consume again when the invoice was already paid", async () => {
    queryOne.mockImplementation(async (sql: string) => (sql.includes("FROM invoices") ? invoiceRow("paid") : { paid: "1000" }));
    expect(await recomputeInvoiceStatus("inv1")).toBe("paid");
    expect(consumeForInvoice).not.toHaveBeenCalled();
  });

  it("does not consume for partial payments", async () => {
    queryOne.mockImplementation(async (sql: string) => (sql.includes("FROM invoices") ? invoiceRow("sent") : { paid: "400" }));
    expect(await recomputeInvoiceStatus("inv1")).toBe("partially_paid");
    expect(consumeForInvoice).not.toHaveBeenCalled();
  });

  it("a stock failure never undoes or blocks the paid status", async () => {
    queryOne.mockImplementation(async (sql: string) => (sql.includes("FROM invoices") ? invoiceRow("sent") : { paid: "1000" }));
    consumeForInvoice.mockRejectedValue(new Error("Insufficient stock"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(recomputeInvoiceStatus("inv1")).resolves.toBe("paid");
    const upd = query.mock.calls.find(([sql]) => String(sql).includes("UPDATE invoices SET paid_minor"));
    expect(upd?.[1]).toEqual(["inv1", 1000, "paid"]);
    spy.mockRestore();
  });
});
