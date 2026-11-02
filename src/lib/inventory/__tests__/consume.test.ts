import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.fn();
const queryOne = vi.fn();
vi.mock("@/lib/dsql", () => ({
  query: (...args: unknown[]) => query(...args),
  queryOne: (...args: unknown[]) => queryOne(...args),
  withRetry: (fn: () => unknown) => fn(),
}));

import { consumeForInvoice } from "@/lib/inventory/stock";

const cols =
  "id, user_id, sku, name, description, kind, unit, unit_price_minor, cost_minor, currency, tax_rate_bp, track_stock, stock_on_hand, stock_reserved, reorder_point, active, deleted_at, created_at, updated_at";
void cols;

function productRow(id: string) {
  return {
    id, user_id: "o1", sku: null, name: id, description: null, kind: "product", unit: "each", unit_price_minor: "100", cost_minor: "50",
    currency: "USD", tax_rate_bp: 0, track_stock: true, stock_on_hand: 10, stock_reserved: 0, reorder_point: 0, active: true, deleted_at: null, created_at: "", updated_at: "",
  };
}

beforeEach(() => {
  query.mockReset();
  queryOne.mockReset();
});

describe("consumeForInvoice idempotency", () => {
  const items = [
    { description: "A", qty: 2, unit_minor: 100, tax_rate_bp: 0, product_id: "pA" },
    { description: "B", qty: 3, unit_minor: 100, tax_rate_bp: 0, product_id: "pB" },
  ];

  it("resumes a partially consumed invoice: skips products already consumed, consumes the rest", async () => {
    const updates: unknown[][] = [];
    query.mockImplementation(async (sql: string, params: unknown[]) => {
      if (sql.includes("FROM stock_movements") && sql.includes("ref_kind = 'invoice'")) {
        // A previous run consumed pA then failed on pB.
        return [{ product_id: "pA", kind: "consume", qty: 2 }];
      }
      if (sql.includes("FROM products") && sql.includes("ANY($2::text[])")) return [productRow("pA"), productRow("pB")];
      if (sql.startsWith("UPDATE products")) {
        updates.push(params);
        return [{ id: params[0] }];
      }
      if (sql.includes("INSERT INTO stock_movements")) return [];
      return [];
    });
    queryOne.mockImplementation(async (sql: string, params: unknown[]) => {
      if (sql.includes("FROM stock_movements WHERE id")) return { id: params[0], product_id: "pB", kind: "consume", qty: 3 };
      return null;
    });

    const out = await consumeForInvoice("o1", "inv1", items);
    // Only pB is decremented this time...
    expect(updates).toHaveLength(1);
    expect(updates[0]?.[0]).toBe("pB");
    // ...and the result reports both products as consumed.
    expect(out).toEqual([
      { product_id: "pA", qty: 2 },
      { product_id: "pB", qty: 3 },
    ]);
  });

  it("is a pure no-op when every product was already consumed", async () => {
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM stock_movements") && sql.includes("ref_kind = 'invoice'")) {
        return [
          { product_id: "pA", kind: "consume", qty: 2 },
          { product_id: "pB", kind: "consume", qty: 3 },
        ];
      }
      if (sql.includes("FROM products")) return [productRow("pA"), productRow("pB")];
      throw new Error(`unexpected write: ${sql.slice(0, 40)}`);
    });
    const out = await consumeForInvoice("o1", "inv1", items);
    expect(out).toEqual([
      { product_id: "pA", qty: 2 },
      { product_id: "pB", qty: 3 },
    ]);
    expect(query.mock.calls.some(([sql]) => String(sql).startsWith("UPDATE products"))).toBe(false);
  });
});
