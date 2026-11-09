import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * SEC: two concurrent checkouts with the same cart cookie can never produce
 * two orders. The cart is claimed with a conditional UPDATE before stock is
 * reserved; the loser deletes its order row and gets `already_ordered`.
 */
const db = vi.hoisted(() => ({
  query: vi.fn<(sql: string, values?: unknown[]) => Promise<unknown[]>>(async () => []),
  queryOne: vi.fn<(sql: string, values?: unknown[]) => Promise<unknown>>(async () => null),
  withRetry: vi.fn(async <T,>(fn: () => Promise<T>) => fn()),
}));
vi.mock("@/lib/dsql", () => db);
vi.mock("@/lib/events/bus", () => ({ emitEvent: vi.fn(async () => undefined) }));
vi.mock("@/lib/table-exists", () => ({ tableExists: vi.fn(async () => true) }));
vi.mock("@/lib/money/tax-rates", () => ({ resolveDocumentTotals: vi.fn(async () => ({ subtotal_minor: 1000, tax_minor: 0, total_minor: 1000, breakdown: [] })) }));
vi.mock("@/lib/money/invoices", () => ({ createInvoice: vi.fn(async () => ({ id: "inv1" })), createPayLink: vi.fn(async () => ({ url: "https://pay", provider: "simulated" })) }));
vi.mock("@/lib/privacy/consent", () => ({ recordConsent: vi.fn(async () => undefined) }));
const stock = vi.hoisted(() => ({ reserveForOrder: vi.fn(async () => ({ reserved: [], alreadyReserved: false })), releaseForOrder: vi.fn(async () => []), isInsufficientStock: () => false }));
vi.mock("@/lib/inventory/stock", () => stock);
const catalog = vi.hoisted(() => ({
  visibleProductsByIds: vi.fn(async () => new Map([["p1", { id: "p1", name: "Widget", unit_price_minor: 1000, tax_rate_bp: 0, track_stock: false, stock_available: 0 }]])),
}));
vi.mock("@/lib/storefront/catalog", () => catalog);
const orders = vi.hoisted(() => ({
  insertOrder: vi.fn(async () => ({ id: "o1", number: "ORD-1", status: "pending_payment", invoice_id: null, total_minor: 1000, currency: "USD", customer_email: "a@x.test", contact_id: null, items: [], status_label: "Awaiting payment" })),
  deleteUnfinishedOrder: vi.fn(async () => undefined),
  getOrder: vi.fn(async () => ({ id: "o1", number: "ORD-1", status: "pending_payment", invoice_id: "inv1", total_minor: 1000, currency: "USD", customer_email: "a@x.test", contact_id: null, items: [], status_label: "Awaiting payment" })),
  issueOrderLink: vi.fn(async () => ({ token: "t", url: "https://s/o/t", path: "/o/t" })),
  linkOrderInvoice: vi.fn(async () => undefined),
}));
vi.mock("@/lib/storefront/orders", () => orders);

import { claimCartForOrder } from "@/lib/storefront/cart";
import { CheckoutError, createOrderFromCart } from "@/lib/storefront/checkout";

const pub = {
  dataId: "org",
  orgName: "Org",
  storefront: { enabled: true, slug: "org", title: null, intro_md: null, currency: "USD", collect_shipping: false, shipping_flat_minor: 0, pickup_enabled: true, terms_md: null, settings: { max_qty_per_line: 20, cart_ttl_hours: 72 }, fulfil_location_id: null, configured: true, updated_at: null },
};
const cart = { id: "cart1", user_id: "org", token_hash: "h", items: JSON.stringify([{ product_id: "p1", qty: 1 }]), email: null, reminded_at: null, order_id: null, created_at: "", updated_at: "", expires_at: new Date(Date.now() + 60_000).toISOString() };
const input = { name: "A", email: "a@x.test" };

describe("checkout claims the cart exactly once", () => {
  beforeEach(() => {
    db.query.mockReset();
    db.queryOne.mockReset();
    orders.deleteUnfinishedOrder.mockClear();
    stock.reserveForOrder.mockClear();
  });

  it("claimCartForOrder uses a conditional UPDATE on order_id IS NULL", async () => {
    db.query.mockResolvedValueOnce([{ id: "cart1" }]);
    expect(await claimCartForOrder("cart1", "o1")).toBe(true);
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/UPDATE carts SET order_id = \$2[\s\S]*WHERE id = \$1 AND order_id IS NULL RETURNING id/);
    expect(params).toEqual(["cart1", "o1"]);
  });

  it("the losing checkout deletes its order, reserves nothing and reports already_ordered (409)", async () => {
    db.query.mockImplementation(async (sql: string) => (sql.includes("UPDATE carts SET order_id") ? [] : []));
    db.queryOne.mockResolvedValue(null);
    await expect(createOrderFromCart(pub, cart, input)).rejects.toMatchObject({ name: "CheckoutError", code: "already_ordered" });
    expect(orders.deleteUnfinishedOrder).toHaveBeenCalledWith("org", "o1");
    expect(stock.reserveForOrder).not.toHaveBeenCalled();
    const { shopError } = await import("@/lib/storefront/http");
    expect(shopError(new CheckoutError("already_ordered", "x"), "t").status).toBe(409);
  });

  it("the winning checkout proceeds to reserve stock", async () => {
    db.query.mockImplementation(async (sql: string) => (sql.includes("UPDATE carts SET order_id") ? [{ id: "cart1" }] : []));
    db.queryOne.mockResolvedValue(null);
    const out = await createOrderFromCart(pub, cart, input);
    expect(out.order.id).toBe("o1");
    expect(stock.reserveForOrder).toHaveBeenCalledTimes(1);
  });
});
