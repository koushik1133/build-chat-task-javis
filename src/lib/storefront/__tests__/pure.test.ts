import { describe, expect, it } from "vitest";
import { computeTotals } from "@/lib/money/tax";
import { applyCartChange, canTransition, CartError, cartUnits, combineOrderTotals, isTerminal, ORDER_STATUSES, parseCartItems, shippingCharge } from "../pure";
import { cartToLineItems } from "../cart";
import { publicImageUrl, toCatalogItem } from "../catalog";

const limits = { maxQtyPerLine: 5, maxLines: 2 };

describe("cart maths", () => {
  it("adds, replaces and removes lines", () => {
    let items = applyCartChange([], { product_id: "a", qty: 1, add: true }, limits);
    items = applyCartChange(items, { product_id: "a", qty: 2, add: true }, limits);
    expect(items).toEqual([{ product_id: "a", qty: 3 }]);
    items = applyCartChange(items, { product_id: "a", qty: 1 }, limits);
    expect(items).toEqual([{ product_id: "a", qty: 1 }]);
    items = applyCartChange(items, { product_id: "a", qty: 0 }, limits);
    expect(items).toEqual([]);
    expect(cartUnits([{ product_id: "a", qty: 2 }, { product_id: "b", qty: 3 }])).toBe(5);
  });

  it("clamps additive quantity to the per-line cap and rejects explicit overflow", () => {
    const clamped = applyCartChange([{ product_id: "a", qty: 4 }], { product_id: "a", qty: 10, add: true }, limits);
    expect(clamped[0].qty).toBe(5);
    expect(() => applyCartChange([], { product_id: "a", qty: 6 }, limits)).toThrow(CartError);
  });

  it("caps the number of distinct lines", () => {
    const two = [{ product_id: "a", qty: 1 }, { product_id: "b", qty: 1 }];
    expect(() => applyCartChange(two, { product_id: "c", qty: 1 }, limits)).toThrowError(/at most 2/);
    // Existing lines can still change.
    expect(applyCartChange(two, { product_id: "a", qty: 2 }, limits)[0].qty).toBe(2);
  });

  it("checks stock availability for tracked products only", () => {
    const available = new Map<string, number | null>([["tracked", 2], ["service", null]]);
    expect(() => applyCartChange([], { product_id: "tracked", qty: 3 }, { ...limits, available })).toThrowError(/Only 2 left/);
    expect(applyCartChange([], { product_id: "tracked", qty: 2 }, { ...limits, available })[0].qty).toBe(2);
    expect(applyCartChange([], { product_id: "service", qty: 5 }, { ...limits, available })[0].qty).toBe(5);
    const out = new Map<string, number | null>([["gone", 0]]);
    try {
      applyCartChange([], { product_id: "gone", qty: 1 }, { ...limits, available: out });
      expect.fail("should throw");
    } catch (e) {
      expect((e as CartError).code).toBe("out_of_stock");
    }
  });

  it("parses stored items defensively", () => {
    expect(parseCartItems(null)).toEqual([]);
    expect(parseCartItems("nope")).toEqual([]);
    expect(parseCartItems(JSON.stringify([{ product_id: "a", qty: 2 }]))).toEqual([{ product_id: "a", qty: 2 }]);
    expect(parseCartItems(JSON.stringify([{ product_id: "a", qty: 0 }]))).toEqual([]);
  });

  it("snapshots pricebook price and tax into line items, skipping unknown products", () => {
    const products = new Map([["a", { id: "a", name: "Widget", unit_price_minor: 1000, tax_rate_bp: 2000 }]]);
    const lines = cartToLineItems([{ product_id: "a", qty: 2 }, { product_id: "zzz", qty: 1 }], products);
    expect(lines).toEqual([{ description: "Widget", qty: 2, unit_minor: 1000, tax_rate_bp: 2000, product_id: "a" }]);
  });
});

describe("order totals", () => {
  const lines = [
    { qty: 2, unit_minor: 1000, tax_rate_bp: 2000 },
    { qty: 1, unit_minor: 550, tax_rate_bp: 0 },
  ];
  const sf = { collect_shipping: true, shipping_flat_minor: 499, pickup_enabled: true };

  it("exclusive tax: tax is added on top, shipping is untaxed", () => {
    const goods = computeTotals(lines, [], { inclusive: false });
    expect(goods).toMatchObject({ subtotal_minor: 2550, tax_minor: 400, total_minor: 2950 });
    const t = combineOrderTotals({ goods, shipping_minor: shippingCharge(sf, false) });
    expect(t).toEqual({ subtotal_minor: 2550, tax_minor: 400, shipping_minor: 499, total_minor: 3449 });
  });

  it("inclusive tax: net is backed out of the price, total equals the sticker price plus shipping", () => {
    const goods = computeTotals(lines, [], { inclusive: true });
    // 2000 gross at 20% → net 1667 (half-up), tax 333; 550 at 0% stays 550.
    expect(goods).toMatchObject({ subtotal_minor: 2217, tax_minor: 333, total_minor: 2550 });
    const t = combineOrderTotals({ goods, shipping_minor: shippingCharge(sf, false) });
    expect(t.total_minor).toBe(2550 + 499);
  });

  it("shipping is free for pickup, zero when the shop does not ship, and never negative", () => {
    expect(shippingCharge(sf, true)).toBe(0);
    expect(shippingCharge({ ...sf, pickup_enabled: false }, true)).toBe(499);
    expect(shippingCharge({ ...sf, collect_shipping: false }, false)).toBe(0);
    expect(combineOrderTotals({ goods: { subtotal_minor: 1, tax_minor: 0, total_minor: 1 }, shipping_minor: -5 }).shipping_minor).toBe(0);
  });
});

describe("order status machine", () => {
  it("allows only the documented transitions", () => {
    expect(canTransition("pending_payment", "paid")).toBe(true);
    expect(canTransition("pending_payment", "cancelled")).toBe(true);
    expect(canTransition("pending_payment", "fulfilled")).toBe(false);
    expect(canTransition("paid", "fulfilled")).toBe(true);
    expect(canTransition("paid", "refunded")).toBe(true);
    expect(canTransition("fulfilled", "refunded")).toBe(true);
    expect(canTransition("fulfilled", "paid")).toBe(false);
    expect(canTransition("cancelled", "paid")).toBe(false);
    expect(canTransition("refunded", "fulfilled")).toBe(false);
  });
  it("cancelled and refunded are terminal", () => {
    expect(ORDER_STATUSES.filter(isTerminal)).toEqual(["cancelled", "refunded"]);
  });
});

describe("catalog view", () => {
  const base = {
    id: "p1", sku: "SKU", name: "Thing", description: "Pricebook text", kind: "product" as const, unit: "each", unit_price_minor: 1200, cost_minor: 0, currency: "USD", tax_rate_bp: 0,
    track_stock: true, stock_on_hand: 3, stock_reserved: 1, stock_available: 2, reorder_point: 2, low_stock: true, preferred_supplier_id: null, last_cost_minor: null, active: true, created_at: "", updated_at: "",
    visible: true, sort: 0, description_md: null, image_url: "attachment:abc12345",
  };
  it("maps stock, descriptions and image references", () => {
    const item = toCatalogItem(base, "my-shop");
    expect(item).toMatchObject({ stock_available: 2, in_stock: true, low_stock: true, description: "Pricebook text", image_url: "/api/shop/my-shop/image/abc12345" });
    expect(toCatalogItem({ ...base, stock_available: 0 }, "s").in_stock).toBe(false);
    expect(toCatalogItem({ ...base, track_stock: false, stock_available: 0 }, "s")).toMatchObject({ in_stock: true, stock_available: null });
    expect(toCatalogItem({ ...base, description_md: "Shop copy" }, "s").description).toBe("Shop copy");
  });
  it("only serves safe image URLs", () => {
    expect(publicImageUrl("s", "https://cdn.example.com/a.png")).toBe("https://cdn.example.com/a.png");
    expect(publicImageUrl("s", "javascript:alert(1)")).toBeNull();
    expect(publicImageUrl("s", null)).toBeNull();
  });
});
