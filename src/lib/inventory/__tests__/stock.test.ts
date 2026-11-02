import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.fn();
const queryOne = vi.fn();
vi.mock("@/lib/dsql", () => ({
  query: (...args: unknown[]) => query(...args),
  queryOne: (...args: unknown[]) => queryOne(...args),
  withRetry: (fn: () => unknown) => fn(),
}));

import { InsufficientStockError, isInsufficientStock, outstandingReservations, planStockOps, reserveForQuote } from "@/lib/inventory/stock";
import { availableQty, isLowStock, toProductDTO, type ProductRow } from "@/lib/inventory/products";

function product(over: Partial<ProductRow> = {}): ProductRow {
  return {
    id: "p1", user_id: "o1", sku: "SKU-1", name: "Widget", description: null, kind: "product", unit: "each",
    unit_price_minor: "1500", cost_minor: "700", currency: "USD", tax_rate_bp: 0, track_stock: true,
    stock_on_hand: 10, stock_reserved: 2, reorder_point: 5, active: true, deleted_at: null, created_at: "", updated_at: "",
    ...over,
  };
}

describe("product stock helpers (pure)", () => {
  it("available = on hand − reserved", () => {
    expect(availableQty({ stock_on_hand: 10, stock_reserved: 2 })).toBe(8);
  });
  it("low stock only applies to tracked products at or below the reorder point", () => {
    expect(isLowStock({ track_stock: true, stock_on_hand: 10, stock_reserved: 5, reorder_point: 5 })).toBe(true);
    expect(isLowStock({ track_stock: true, stock_on_hand: 10, stock_reserved: 4, reorder_point: 5 })).toBe(false);
    expect(isLowStock({ track_stock: false, stock_on_hand: 0, stock_reserved: 0, reorder_point: 5 })).toBe(false);
  });
  it("toProductDTO coerces bigint strings and derives availability", () => {
    const dto = toProductDTO(product({ stock_on_hand: 3, stock_reserved: 1 }));
    expect(dto.unit_price_minor).toBe(1500);
    expect(dto.cost_minor).toBe(700);
    expect(dto.stock_available).toBe(2);
    expect(dto.low_stock).toBe(true);
  });
});

describe("planStockOps", () => {
  const products = new Map([
    ["p1", { id: "p1", track_stock: true }],
    ["p2", { id: "p2", track_stock: false }],
  ]);
  it("groups tracked products, rounds fractional qty up and ignores untracked/unknown/missing", () => {
    const ops = planStockOps(
      [
        { qty: 2, product_id: "p1" },
        { qty: 1.2, product_id: "p1" },
        { qty: 5, product_id: "p2" },
        { qty: 5, product_id: "nope" },
        { qty: 5 },
        { qty: 0, product_id: "p1" },
      ],
      products
    );
    expect(ops).toEqual([{ product_id: "p1", qty: 4 }]);
  });
  it("returns nothing for empty input", () => {
    expect(planStockOps([], products)).toEqual([]);
  });
});

describe("outstandingReservations", () => {
  it("nets reserve/checkout against release/checkin/consume and drops zeroed products", () => {
    const open = outstandingReservations([
      { product_id: "a", kind: "reserve", qty: 5 },
      { product_id: "a", kind: "release", qty: 2 },
      { product_id: "b", kind: "checkout", qty: 1 },
      { product_id: "b", kind: "checkin", qty: 1 },
      { product_id: "c", kind: "reserve", qty: 3 },
      { product_id: "c", kind: "consume", qty: 3 },
      { product_id: "d", kind: "receive", qty: 50 },
    ]);
    expect([...open]).toEqual([["a", 3]]);
  });
});

describe("InsufficientStockError", () => {
  it("carries the shortfall and is detectable", () => {
    const e = new InsufficientStockError("p1", "Widget", 5, 2);
    expect(e.message).toBe('Insufficient stock for "Widget": requested 5, available 2');
    expect(e.code).toBe("INSUFFICIENT_STOCK");
    expect(isInsufficientStock(e)).toBe(true);
    expect(isInsufficientStock(new Error("x"))).toBe(false);
  });
});

describe("reserveForQuote", () => {
  beforeEach(() => {
    query.mockReset();
    queryOne.mockReset();
  });

  it("is a no-op when the quote already holds reservations", async () => {
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM stock_movements")) return [{ product_id: "p1", kind: "reserve", qty: 2 }];
      return [];
    });
    const r = await reserveForQuote("o1", "q1", [{ description: "x", qty: 2, unit_minor: 1, tax_rate_bp: 0, product_id: "p1" }]);
    expect(r.alreadyReserved).toBe(true);
    expect(r.reserved).toEqual([{ product_id: "p1", qty: 2 }]);
    expect(query.mock.calls.some(([sql]) => String(sql).startsWith("UPDATE products"))).toBe(false);
  });

  it("uses a conditional UPDATE (on_hand − reserved >= qty) and logs a reserve movement", async () => {
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM stock_movements")) return [];
      if (sql.includes("FROM products")) return [product()];
      if (sql.startsWith("UPDATE products")) return [{ id: "p1" }];
      return [];
    });
    queryOne.mockResolvedValue({ id: "m1" });
    const r = await reserveForQuote("o1", "q1", [{ description: "x", qty: 3, unit_minor: 1, tax_rate_bp: 0, product_id: "p1" }]);
    expect(r).toEqual({ reserved: [{ product_id: "p1", qty: 3 }], alreadyReserved: false });
    const upd = query.mock.calls.find(([sql]) => String(sql).startsWith("UPDATE products"));
    expect(String(upd?.[0])).toContain("stock_on_hand - stock_reserved >= $3");
    expect(upd?.[1]).toEqual(["p1", "o1", 3]);
    const ins = query.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO stock_movements"));
    expect(ins?.[1]).toEqual(expect.arrayContaining(["p1", "reserve", 3, "quote", "q1"]));
  });

  it("throws InsufficientStockError when the conditional UPDATE matches no row", async () => {
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM stock_movements")) return [];
      if (sql.includes("FROM products")) return [product({ stock_on_hand: 2, stock_reserved: 1 })];
      if (sql.startsWith("UPDATE products")) return [];
      return [];
    });
    queryOne.mockImplementation(async (sql: string) => (sql.includes("FROM products") ? product({ stock_on_hand: 2, stock_reserved: 1 }) : null));
    await expect(
      reserveForQuote("o1", "q1", [{ description: "x", qty: 5, unit_minor: 1, tax_rate_bp: 0, product_id: "p1" }])
    ).rejects.toMatchObject({ name: "InsufficientStockError", requested: 5, available: 1 });
  });
});
