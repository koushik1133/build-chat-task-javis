import { randomBytes, randomUUID } from "crypto";
import { query, queryOne } from "@/lib/dsql";
import { hashToken, appOrigin } from "@/lib/share-tokens";
import { emitEvent } from "@/lib/events/bus";
import { tableExists } from "@/lib/table-exists";
import { resolveDocumentTotals } from "@/lib/money/tax-rates";
import type { LineItem } from "@/lib/money/items";
import { visibleProductsByIds, toCatalogItem, type CatalogItem } from "./catalog";
import type { PublicStorefront, StorefrontDTO } from "./settings";
import { applyCartChange, CART_LIMITS, combineOrderTotals, parseCartItems, shippingCharge, type CartChange, type CartItem } from "./pure";

/**
 * Anonymous shopper carts. The browser holds a random token in the
 * `kh_cart_<slug>` cookie; only its sha256 is stored. Carts expire after the
 * storefront's cart TTL and are never shared across orgs (user_id check).
 */

export interface CartRow {
  id: string;
  user_id: string;
  token_hash: string;
  items: string | null;
  email: string | null;
  reminded_at: string | null;
  order_id: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string;
}

export function cartCookieName(slug: string): string {
  return `kh_cart_${slug.replace(/[^a-z0-9]/gi, "_")}`;
}

const COLS = "id, user_id, token_hash, items, email, reminded_at, order_id, created_at, updated_at, expires_at";

export async function getCartByToken(dataId: string, token: string | null | undefined): Promise<CartRow | null> {
  if (!token || token.length > 128 || !/^[A-Za-z0-9_-]+$/.test(token)) return null;
  const row = await queryOne<CartRow>(`SELECT ${COLS} FROM carts WHERE token_hash = $1 AND user_id = $2`, [hashToken(token), dataId]);
  if (!row) return null;
  if (row.order_id) return null; // checked out: start fresh
  if (new Date(row.expires_at).getTime() < Date.now()) return null;
  return row;
}

export async function createCart(dataId: string, sf: StorefrontDTO): Promise<{ cart: CartRow; token: string }> {
  const token = randomBytes(24).toString("base64url");
  const id = randomUUID();
  const expires = new Date(Date.now() + sf.settings.cart_ttl_hours * 3_600_000).toISOString();
  await query(`INSERT INTO carts (id, user_id, token_hash, items, expires_at) VALUES ($1, $2, $3, '[]', $4)`, [id, dataId, hashToken(token), expires]);
  const cart = await queryOne<CartRow>(`SELECT ${COLS} FROM carts WHERE id = $1`, [id]);
  if (!cart) throw new Error("Cart vanished after insert");
  return { cart, token };
}

/** Existing live cart for the token, or a brand-new one (token returned only when created). */
export async function getOrCreateCart(dataId: string, sf: StorefrontDTO, token: string | null | undefined): Promise<{ cart: CartRow; token: string | null }> {
  const existing = await getCartByToken(dataId, token);
  if (existing) return { cart: existing, token: null };
  const created = await createCart(dataId, sf);
  return { cart: created.cart, token: created.token };
}

/** Apply a quantity change, enforcing caps and stock. Returns the updated row. */
export async function changeCart(dataId: string, sf: StorefrontDTO, cart: CartRow, change: CartChange): Promise<CartRow> {
  const items = parseCartItems(cart.items);
  const products = await visibleProductsByIds(dataId, [...items.map((i) => i.product_id), change.product_id]);
  if (change.qty > 0 && !products.has(change.product_id)) throw new Error("Product not found");
  const available = new Map<string, number | null>();
  for (const [id, p] of products) available.set(id, p.track_stock ? p.stock_available : null);
  const next = applyCartChange(items, change, { maxQtyPerLine: sf.settings.max_qty_per_line, maxLines: CART_LIMITS.maxLines, available });
  const expires = new Date(Date.now() + sf.settings.cart_ttl_hours * 3_600_000).toISOString();
  await query(`UPDATE carts SET items = $2, updated_at = NOW(), expires_at = $3 WHERE id = $1`, [cart.id, JSON.stringify(next), expires]);
  const row = await queryOne<CartRow>(`SELECT ${COLS} FROM carts WHERE id = $1`, [cart.id]);
  if (!row) throw new Error("Cart not found");
  return row;
}

/** Remember the shopper's email (abandoned-cart reminders). */
export async function setCartEmail(cartId: string, email: string | null): Promise<void> {
  await query(`UPDATE carts SET email = $2, updated_at = NOW() WHERE id = $1`, [cartId, email?.trim().toLowerCase() || null]);
}

export async function markCartOrdered(cartId: string, orderId: string): Promise<void> {
  await query(`UPDATE carts SET order_id = $2, updated_at = NOW() WHERE id = $1`, [cartId, orderId]);
}

export interface CartLine extends CatalogItem {
  qty: number;
  line_minor: number;
}

export interface CartView {
  id: string;
  items: CartLine[];
  units: number;
  currency: string;
  subtotal_minor: number;
  tax_minor: number;
  shipping_minor: number;
  total_minor: number;
  prices_include_tax: boolean;
  /** Products in the cart that are no longer available (hidden / out of stock); shown as warnings. */
  unavailable: Array<{ product_id: string; reason: "unavailable" | "insufficient_stock"; available: number | null }>;
  email: string | null;
  expires_at: string;
}

/** Cart lines become invoice/order line items (price and tax snapshot from the pricebook). */
export function cartToLineItems(items: readonly CartItem[], products: ReadonlyMap<string, { id: string; name: string; unit_price_minor: number; tax_rate_bp: number }>): LineItem[] {
  const out: LineItem[] = [];
  for (const it of items) {
    const p = products.get(it.product_id);
    if (!p) continue;
    out.push({ description: p.name, qty: it.qty, unit_minor: p.unit_price_minor, tax_rate_bp: p.tax_rate_bp, product_id: p.id });
  }
  return out;
}

/** Public cart view: lines with current prices, tax-engine totals and (when applicable) shipping. */
export async function cartView(pub: PublicStorefront, cart: CartRow, opts: { pickup?: boolean } = {}): Promise<CartView> {
  const items = parseCartItems(cart.items);
  const products = await visibleProductsByIds(pub.dataId, items.map((i) => i.product_id));
  const lines: CartLine[] = [];
  const unavailable: CartView["unavailable"] = [];
  for (const it of items) {
    const p = products.get(it.product_id);
    if (!p) {
      unavailable.push({ product_id: it.product_id, reason: "unavailable", available: null });
      continue;
    }
    if (p.track_stock && p.stock_available < it.qty) unavailable.push({ product_id: it.product_id, reason: "insufficient_stock", available: p.stock_available });
    lines.push({ ...toCatalogItem(p, pub.storefront.slug), qty: it.qty, line_minor: it.qty * p.unit_price_minor });
  }
  const lineItems = cartToLineItems(items, products);
  const goods = await resolveDocumentTotals(pub.dataId, lineItems);
  const { getBillingSettings } = await import("@/lib/money/settings");
  const billing = await getBillingSettings(pub.dataId);
  const totals = combineOrderTotals({ goods, shipping_minor: lines.length > 0 ? shippingCharge(pub.storefront, opts.pickup ?? !pub.storefront.collect_shipping) : 0 });
  return {
    id: cart.id,
    items: lines,
    units: lines.reduce((s, l) => s + l.qty, 0),
    currency: pub.storefront.currency,
    ...totals,
    prices_include_tax: billing.prices_include_tax,
    unavailable,
    email: cart.email,
    expires_at: new Date(cart.expires_at).toISOString(),
  };
}

/* ── abandoned carts ────────────────────────────────────────────────────── */

export interface AbandonedSweepResult {
  emitted: number;
}

/**
 * Cron hook: carts with an email, not checked out, untouched for `olderThanMs`
 * (default 2h) and not yet reminded → one `cart.abandoned` event each. The
 * conditional UPDATE on `reminded_at IS NULL` makes the sweep idempotent even
 * when two ticks overlap. The event carries the matched contact id (by email)
 * so a consent-gated reminder can run from an automation.
 */
export async function abandonedCartSweep(limit = 100, olderThanMs = 2 * 3_600_000): Promise<AbandonedSweepResult> {
  if (!(await tableExists("carts"))) return { emitted: 0 };
  const cutoff = new Date(Date.now() - olderThanMs).toISOString();
  const rows = await query<CartRow>(
    `SELECT ${COLS} FROM carts WHERE email IS NOT NULL AND order_id IS NULL AND reminded_at IS NULL AND updated_at < $1 AND expires_at > NOW() AND items <> '[]'
      ORDER BY updated_at ASC LIMIT $2`,
    [cutoff, Math.min(Math.max(limit, 1), 500)]
  );
  let emitted = 0;
  for (const cart of rows) {
    const claimed = await query<{ id: string }>(`UPDATE carts SET reminded_at = NOW() WHERE id = $1 AND reminded_at IS NULL RETURNING id`, [cart.id]);
    if (claimed.length === 0) continue;
    const items = parseCartItems(cart.items);
    const contact = cart.email
      ? await queryOne<{ id: string }>(`SELECT id FROM crm_contacts WHERE user_id = $1 AND lower(email) = $2 AND deleted_at IS NULL LIMIT 1`, [cart.user_id, cart.email.toLowerCase()]).catch(() => null)
      : null;
    const sf = await queryOne<{ slug: string }>(`SELECT slug FROM storefronts WHERE user_id = $1`, [cart.user_id]);
    await emitEvent(cart.user_id, {
      type: "cart.abandoned",
      entity: "cart",
      entityId: cart.id,
      data: {
        email: cart.email,
        contact_id: contact?.id ?? null,
        units: items.reduce((s, i) => s + i.qty, 0),
        lines: items.length,
        shop_url: sf ? `${appOrigin()}/shop/${sf.slug}/cart` : null,
        last_activity_at: new Date(cart.updated_at).toISOString(),
      },
    });
    emitted += 1;
  }
  return { emitted };
}
