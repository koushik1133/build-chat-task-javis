import { randomUUID } from "crypto";
import { z } from "zod";
import { query, queryOne } from "@/lib/dsql";
import { emitEvent } from "@/lib/events/bus";
import { createInvoice, createPayLink } from "@/lib/money/invoices";
import { resolveDocumentTotals } from "@/lib/money/tax-rates";
import type { LineItem } from "@/lib/money/items";
import { isInsufficientStock, reserveForOrder, releaseForOrder } from "@/lib/inventory/stock";
import { recordConsent, type ConsentEvidence } from "@/lib/privacy/consent";
import { cartToLineItems, markCartOrdered, setCartEmail, type CartRow } from "./cart";
import { visibleProductsByIds } from "./catalog";
import { deleteUnfinishedOrder, getOrder, insertOrder, issueOrderLink, linkOrderInvoice, type OrderDTO } from "./orders";
import { combineOrderTotals, parseCartItems, shippingCharge, ShippingAddressSchema } from "./pure";
import type { PublicStorefront } from "./settings";

/**
 * Checkout: cart → pending order + reservation + invoice → pay link.
 */

export const CheckoutSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    email: z.string().trim().toLowerCase().email().max(320),
    phone: z.string().trim().max(40).optional(),
    /** Omitted or null = collection / pickup (when the shop allows it). */
    shipping: ShippingAddressSchema.nullable().optional(),
    consent: z.object({ marketing: z.boolean().optional() }).strict().optional(),
    notes: z.string().trim().max(2000).optional(),
  })
  .strict();
export type CheckoutInput = z.infer<typeof CheckoutSchema>;

export class CheckoutError extends Error {
  constructor(public readonly code: "empty_cart" | "unavailable" | "insufficient_stock" | "shipping_required" | "pickup_disabled", message: string, public readonly detail: Record<string, unknown> = {}) {
    super(message);
    this.name = "CheckoutError";
  }
}

/** Find a contact by email, or create one tagged "storefront". Returns {id, created}. */
async function matchOrCreateContact(dataId: string, input: { name: string; email: string; phone?: string | null }): Promise<{ id: string; created: boolean } | null> {
  try {
    const existing = await queryOne<{ id: string }>(`SELECT id FROM crm_contacts WHERE user_id = $1 AND lower(email) = $2 AND deleted_at IS NULL ORDER BY created_at ASC LIMIT 1`, [dataId, input.email]);
    if (existing) return { id: existing.id, created: false };
    const id = randomUUID();
    await query(
      `INSERT INTO crm_contacts (id, user_id, domain, full_name, email, phone, tags, lifecycle, notes, last_contact)
       VALUES ($1, $2, 'general', $3, $4, $5, '["storefront"]', 'customer', NULL, NOW())`,
      [id, dataId, input.name.trim().slice(0, 200), input.email, input.phone?.trim() || null]
    );
    void emitEvent(dataId, { type: "crm.contact.created", entity: "contact", entityId: id, data: { source: "storefront" } });
    return { id, created: true };
  } catch (err) {
    console.error("[checkout] contact match failed:", err);
    return null;
  }
}

export interface CheckoutResult {
  order: OrderDTO;
  status_url: string;
  status_token: string;
  pay_url: string;
}

/**
 * Turn a live cart into a pending order. Order of operations is chosen so a
 * failure leaves nothing half-done: totals → order row → stock reservation
 * (rolls the row back on insufficient stock) → contact → invoice → cart marked.
 */
export async function createOrderFromCart(pub: PublicStorefront, cart: CartRow, input: CheckoutInput, evidence: ConsentEvidence = {}): Promise<CheckoutResult> {
  const sf = pub.storefront;
  const items = parseCartItems(cart.items);
  if (items.length === 0) throw new CheckoutError("empty_cart", "Your cart is empty");
  const products = await visibleProductsByIds(pub.dataId, items.map((i) => i.product_id));
  const missing = items.filter((i) => !products.has(i.product_id));
  if (missing.length > 0) throw new CheckoutError("unavailable", "Some products in your cart are no longer available", { product_ids: missing.map((m) => m.product_id) });
  for (const it of items) {
    const p = products.get(it.product_id);
    if (p?.track_stock && p.stock_available < it.qty) {
      throw new CheckoutError("insufficient_stock", `Only ${p.stock_available} of "${p.name}" left`, { product_id: p.id, available: p.stock_available });
    }
  }
  const pickup = !input.shipping;
  if (sf.collect_shipping && pickup && !sf.pickup_enabled) throw new CheckoutError("shipping_required", "Please enter a shipping address");
  if (!sf.collect_shipping && input.shipping) throw new CheckoutError("pickup_disabled", "This shop does not ship orders");

  const goodsLines: LineItem[] = cartToLineItems(items, products);
  const shipping = shippingCharge(sf, pickup);
  const invoiceLines: LineItem[] = shipping > 0 ? [...goodsLines, { description: "Shipping", qty: 1, unit_minor: shipping, tax_rate_bp: 0 }] : goodsLines;
  const goods = await resolveDocumentTotals(pub.dataId, goodsLines);
  const totals = combineOrderTotals({ goods, shipping_minor: shipping });

  const contact = await matchOrCreateContact(pub.dataId, { name: input.name, email: input.email, phone: input.phone ?? null });
  const consent = input.consent?.marketing === true;

  const order = await insertOrder(pub.dataId, {
    customer_name: input.name,
    customer_email: input.email,
    customer_phone: input.phone ?? null,
    shipping_address: input.shipping ?? null,
    items: goodsLines,
    ...totals,
    currency: sf.currency,
    tax_breakdown: goods.breakdown,
    contact_id: contact?.id ?? null,
    cart_id: cart.id,
    consent_marketing: consent,
    notes: input.notes ?? null,
  });

  try {
    await reserveForOrder(pub.dataId, order.id, goodsLines);
  } catch (err) {
    await deleteUnfinishedOrder(pub.dataId, order.id).catch(() => undefined);
    if (isInsufficientStock(err)) throw new CheckoutError("insufficient_stock", err.message, { product_id: err.productId, available: err.available });
    throw err;
  }

  let invoiceId: string;
  try {
    const inv = await createInvoice(pub.dataId, { contact_id: contact?.id ?? null, currency: sf.currency, items: invoiceLines, due_at: new Date().toISOString(), terms_days: 0, notes: `Storefront order ${order.number}` });
    // Sent and due now: it shows up in receivables/statements immediately and the pay link can be issued.
    await query(`UPDATE invoices SET status = 'sent', sent_at = NOW(), updated_at = NOW() WHERE id = $1 AND user_id = $2 AND status = 'draft'`, [inv.id, pub.dataId]);
    invoiceId = inv.id;
  } catch (err) {
    await releaseForOrder(pub.dataId, order.id, "Rolled back: invoice failed").catch(() => undefined);
    await deleteUnfinishedOrder(pub.dataId, order.id).catch(() => undefined);
    throw err;
  }
  await linkOrderInvoice(pub.dataId, order.id, invoiceId);

  // Consent is recorded against the contact only when the checkout created it; an
  // existing contact's ledger is never rewritten by a shopper. The order itself
  // always keeps the box state (consent_marketing).
  if (contact?.created && input.consent?.marketing !== undefined) {
    void recordConsent(pub.dataId, { kind: "contact", id: contact.id }, "marketing_email", consent ? "granted" : "withdrawn", "form", { ...evidence, text: "Storefront checkout" }).catch(() => undefined);
  }

  await markCartOrdered(cart.id, order.id).catch(() => undefined);
  await setCartEmail(cart.id, input.email).catch(() => undefined);

  const fresh = (await getOrder(pub.dataId, order.id)) ?? order;
  void emitEvent(pub.dataId, {
    type: "order.created",
    entity: "order",
    entityId: order.id,
    data: { number: fresh.number, total_minor: fresh.total_minor, currency: fresh.currency, customer_email: fresh.customer_email, contact_id: fresh.contact_id, invoice_id: invoiceId, lines: goodsLines.length },
  });
  const link = await issueOrderLink(pub.dataId, fresh);
  const pay = await startCheckout(pub.dataId, fresh);
  return { order: fresh, status_url: link.url, status_token: link.token, pay_url: pay.url };
}

/** Payment URL for a pending order: a provider checkout on the linked invoice (simulated → /p/pay/<token>). */
export async function startCheckout(dataId: string, order: OrderDTO): Promise<{ url: string; provider: string }> {
  if (order.status !== "pending_payment") throw new Error(`Order is ${order.status_label.toLowerCase()}`);
  if (!order.invoice_id) throw new Error("Order has no invoice");
  const link = await createPayLink(dataId, order.invoice_id);
  return { url: link.url, provider: link.provider };
}
