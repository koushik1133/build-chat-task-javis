import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.fn();
const queryOne = vi.fn();
vi.mock("@/lib/dsql", () => ({
  query: (...args: unknown[]) => query(...args),
  queryOne: (...args: unknown[]) => queryOne(...args),
  withRetry: (fn: () => unknown) => fn(),
}));
const getQuote = vi.fn();
const getInvoice = vi.fn();
vi.mock("@/lib/money/quotes", () => ({ getQuote: (...a: unknown[]) => getQuote(...a) }));
vi.mock("@/lib/money/invoices", () => ({
  getInvoice: (...a: unknown[]) => getInvoice(...a),
  createInvoice: vi.fn(),
  updateInvoice: vi.fn(),
}));

import { updateChangeOrder } from "@/lib/finance/change-orders";

const co = {
  id: "co1", user_id: "org", quote_id: "q1", invoice_id: "i1", number: 3, title: "Extra", description: null, items: "[]",
  delta_minor: "0", currency: "USD", status: "draft", accepted_at: null, created_at: "", updated_at: "",
};

beforeEach(() => {
  query.mockReset();
  queryOne.mockReset();
  getQuote.mockReset();
  getInvoice.mockReset();
  queryOne.mockResolvedValue(co);
  query.mockResolvedValue([]);
  getQuote.mockResolvedValue({ id: "q1" });
  getInvoice.mockResolvedValue({ id: "i1" });
});

function updateParams(): { sql: string; params: unknown[] } {
  const call = query.mock.calls.find(([s]) => String(s).startsWith("UPDATE change_orders SET")) as [string, unknown[]];
  return { sql: call[0], params: call[1] };
}

describe("updateChangeOrder links", () => {
  it("an explicit null clears the quote link instead of keeping the old id", async () => {
    await updateChangeOrder("org", "co1", { quote_id: null });
    expect(getQuote).not.toHaveBeenCalled();
    const { sql, params } = updateParams();
    expect(sql).toContain("quote_id = $3");
    expect(params[2]).toBeNull();
    // invoice_id untouched
    expect(sql).not.toContain("invoice_id");
  });

  it("an explicit null clears the invoice link", async () => {
    await updateChangeOrder("org", "co1", { invoice_id: null });
    expect(getInvoice).not.toHaveBeenCalled();
    const { sql, params } = updateParams();
    expect(sql).toContain("invoice_id = $3");
    expect(params[2]).toBeNull();
  });

  it("omitting a link keeps it and re-validates the current one when the other changes", async () => {
    getQuote.mockResolvedValue({ id: "q2" });
    await updateChangeOrder("org", "co1", { quote_id: "q2" });
    expect(getQuote).toHaveBeenCalledWith("org", "q2");
    expect(getInvoice).toHaveBeenCalledWith("org", "i1");
    const { sql, params } = updateParams();
    expect(sql).toContain("quote_id = $3");
    expect(params[2]).toBe("q2");
    expect(sql).not.toContain("invoice_id");
  });
});
