/**
 * Storefront pure helpers (client-safe: no DB, no clock beyond what callers pass).
 * Cart maths, order status machine and the public DTO shapes shared by the
 * server libs, the public pages and the tests.
 */
import { z } from "zod";

export const ORDER_STATUSES = ["pending_payment", "paid", "fulfilled", "cancelled", "refunded"] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/** Allowed transitions. `refunded` is reached from paid/fulfilled via cancel-with-refund. */
const TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  pending_payment: ["paid", "cancelled"],
  paid: ["fulfilled", "cancelled", "refunded"],
  fulfilled: ["refunded"],
  cancelled: [],
  refunded: [],
};

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isOrderStatus(v: unknown): v is OrderStatus {
  return typeof v === "string" && (ORDER_STATUSES as readonly string[]).includes(v);
}

/** Terminal states: nothing further can happen to the order. */
export function isTerminal(status: OrderStatus): boolean {
  return TRANSITIONS[status].length === 0;
}

/* ── cart ──────────────────────────────────────────────────────────────── */

export const CART_LIMITS = { maxLines: 50, maxQtyPerLine: 20 } as const;

export const CartItemSchema = z.object({ product_id: z.string().min(1).max(100), qty: z.number().int().min(1).max(100_000) }).strict();
export type CartItem = z.infer<typeof CartItemSchema>;
export const CartItemsSchema = z.array(CartItemSchema).max(CART_LIMITS.maxLines);

export function parseCartItems(raw: string | null | undefined): CartItem[] {
  if (!raw) return [];
  try {
    const r = CartItemsSchema.safeParse(JSON.parse(raw));
    return r.success ? r.data : [];
  } catch {
    return [];
  }
}

export interface CartChange {
  product_id: string;
  /** Absolute quantity (0 removes). */
  qty: number;
  /** When true, `qty` is added to the existing line instead of replacing it. */
  add?: boolean;
}

export interface CartLimits {
  maxQtyPerLine: number;
  maxLines: number;
  /** Available units per product (null/undefined = untracked, unlimited). */
  available?: ReadonlyMap<string, number | null>;
}

export class CartError extends Error {
  constructor(public readonly code: "max_lines" | "max_qty" | "out_of_stock" | "unknown_product", message: string) {
    super(message);
    this.name = "CartError";
  }
}

/**
 * Pure: apply one change to a cart, enforcing line and quantity caps and (when
 * provided) stock availability. Quantities are clamped to the per-line cap
 * rather than rejected; exceeding stock throws so the shopper sees why.
 */
export function applyCartChange(items: readonly CartItem[], change: CartChange, limits: CartLimits): CartItem[] {
  const next = items.map((i) => ({ ...i }));
  const idx = next.findIndex((i) => i.product_id === change.product_id);
  const current = idx >= 0 ? next[idx].qty : 0;
  let qty = Math.trunc(change.add ? current + change.qty : change.qty);
  if (!Number.isFinite(qty)) qty = 0;
  if (qty <= 0) {
    if (idx >= 0) next.splice(idx, 1);
    return next;
  }
  if (idx < 0 && next.length >= limits.maxLines) throw new CartError("max_lines", `A cart can hold at most ${limits.maxLines} different products`);
  if (qty > limits.maxQtyPerLine) {
    if (!change.add) throw new CartError("max_qty", `At most ${limits.maxQtyPerLine} per product`);
    qty = limits.maxQtyPerLine;
  }
  if (limits.available?.has(change.product_id)) {
    const avail = limits.available.get(change.product_id);
    if (avail !== null && avail !== undefined && qty > avail) {
      throw new CartError("out_of_stock", avail <= 0 ? "This product is out of stock" : `Only ${avail} left in stock`);
    }
  }
  if (idx >= 0) next[idx].qty = qty;
  else next.push({ product_id: change.product_id, qty });
  return next;
}

/** Pure: total units across lines. */
export function cartUnits(items: readonly CartItem[]): number {
  return items.reduce((s, i) => s + i.qty, 0);
}

/* ── totals ─────────────────────────────────────────────────────────────── */

export interface OrderTotalsInput {
  /** Tax-engine totals over the goods lines (excluding shipping). */
  goods: { subtotal_minor: number; tax_minor: number; total_minor: number };
  shipping_minor: number;
}

export interface OrderTotals {
  subtotal_minor: number;
  tax_minor: number;
  shipping_minor: number;
  total_minor: number;
}

/** Pure: shipping is a flat, untaxed amount added after the goods totals. */
export function combineOrderTotals(input: OrderTotalsInput): OrderTotals {
  const shipping = Math.max(0, Math.trunc(input.shipping_minor));
  return {
    subtotal_minor: input.goods.subtotal_minor,
    tax_minor: input.goods.tax_minor,
    shipping_minor: shipping,
    total_minor: input.goods.total_minor + shipping,
  };
}

/** Pure: does this order need a shipping charge? Only when the shop collects shipping and the buyer did not pick up. */
export function shippingCharge(sf: { collect_shipping: boolean; shipping_flat_minor: number; pickup_enabled: boolean }, pickup: boolean): number {
  if (!sf.collect_shipping) return 0;
  if (pickup && sf.pickup_enabled) return 0;
  return Math.max(0, sf.shipping_flat_minor);
}

/* ── shipping address ───────────────────────────────────────────────────── */

export const ShippingAddressSchema = z
  .object({
    line1: z.string().trim().min(1).max(200),
    line2: z.string().trim().max(200).optional(),
    city: z.string().trim().min(1).max(100),
    region: z.string().trim().max(100).optional(),
    postal_code: z.string().trim().max(32).optional(),
    country: z.string().trim().min(2).max(64),
  })
  .strict();
export type ShippingAddress = z.infer<typeof ShippingAddressSchema>;

export function parseShippingAddress(raw: string | null | undefined): ShippingAddress | null {
  if (!raw) return null;
  try {
    const r = ShippingAddressSchema.safeParse(JSON.parse(raw));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

export function formatAddress(a: ShippingAddress | null): string {
  if (!a) return "";
  return [a.line1, a.line2, [a.city, a.region, a.postal_code].filter(Boolean).join(" "), a.country].filter((s) => s && s.trim()).join(", ");
}

/* ── labels ─────────────────────────────────────────────────────────────── */

export const ORDER_STATUS_LABEL: Record<OrderStatus, string> = {
  pending_payment: "Awaiting payment",
  paid: "Paid",
  fulfilled: "Fulfilled",
  cancelled: "Cancelled",
  refunded: "Refunded",
};
