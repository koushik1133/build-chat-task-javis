import { randomUUID } from "crypto";
import { z } from "zod";
import { query, queryOne } from "@/lib/dsql";
import { emitEvent } from "@/lib/events/bus";
import { createInvoice, createPayLink } from "@/lib/money/invoices";
import { resolveDocumentTotals } from "@/lib/money/tax-rates";
import type { LineItem } from "@/lib/money/items";
import { isInsufficientStock, reserveForOrder, releaseForOrder } from "@/lib/inventory/stock";
import { recordConsent, type ConsentEvidence } from "@/lib/privacy/consent";
import { resolveShareToken } from "@/lib/share-tokens";
import { cartToLineItems, claimCartForOrder, releaseCartClaim, setCartEmail, type CartRow } from "./cart";
import { visibleProductsByIds } from "./catalog";
import { deleteUnfinishedOrder, getOrder, insertOrder, issueOrderLink, linkOrderInvoice, type OrderDTO } from "./orders";
import { combineOrderTotals, parseCartItems, shippingCharge, ShippingAddressSchema } from "./pure";
import type { PublicStorefront } from "./settings";
import { quoteShipping, toOrderQuote, type ShippingOption } from "@/lib/shipping/quote";
import { setOrderShipping } from "@/lib/shipping/shipments";

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
    /** Id of an option returned by /shipping-quote; the price is always re-derived server-side. */
    shipping_option_id: z.string().trim().max(300).optional(),
    /** Engagement: voucher codes, loyalty points (needs a portal token), gift card code. */
    discounts: z
      .object({
        voucher_codes: z.array(z.string().trim().min(1).max(40)).max(5).optional(),
        points: z.number().int().min(0).max(10_000_000).optional(),
        gift_card: z.string().trim().max(40).optional(),
        portal_token: z.string().max(200).optional(),
      })
      .strict()
      .optional(),
    /** Referral code captured from `?ref=CODE`. */
    ref: z.string().trim().max(12).optional(),
  })
  .strict();
export type CheckoutInput = z.infer<typeof CheckoutSchema>;

export class CheckoutError extends Error {
  constructor(public readonly code: "empty_cart" | "unavailable" | "insufficient_stock" | "shipping_required" | "pickup_disabled" | "already_ordered" | "no_shipping_option" | "discount_invalid", message: string, public readonly detail: Record<string, unknown> = {}) {
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

  // Engagement discounts (vouchers, loyalty points, gift card). Validated up front; committed after the order exists.
  const dc = input.discounts;
  let discount: Awaited<ReturnType<typeof import("@/lib/engagement/discounts").applyDiscounts>> | null = null;
  let portalContactId: string | null = null;
  if (dc && ((dc.voucher_codes?.length ?? 0) > 0 || (dc.points ?? 0) > 0 || dc.gift_card)) {
    const { applyDiscounts } = await import("@/lib/engagement/discounts");
    if (dc.portal_token) {
      const share = await resolveShareToken("portal", dc.portal_token);
      if (share && share.user_id === pub.dataId) portalContactId = share.entity_id;
    }
    if ((dc.points ?? 0) > 0 && !portalContactId) throw new CheckoutError("discount_invalid", "Sign in to your rewards account to use points", { problems: [{ field: "points", code: "no_account" }] });
    const known = portalContactId ?? (await queryOne<{ id: string }>(`SELECT id FROM crm_contacts WHERE user_id = $1 AND lower(email) = $2 AND deleted_at IS NULL ORDER BY created_at ASC LIMIT 1`, [pub.dataId, input.email]))?.id ?? null;
    discount = await applyDiscounts(pub.dataId, { currency: sf.currency, items: goodsLines, contactId: known, voucherCodes: dc.voucher_codes, loyaltyPoints: dc.points, giftCardCode: dc.gift_card });
    if (discount.problems.length > 0) throw new CheckoutError("discount_invalid", discount.problems[0].message, { problems: discount.problems });
  }
  const orderLines: LineItem[] = discount ? [...goodsLines, ...discount.lines] : goodsLines;
  // Shipping rules (when the org defined any) price the delivery; otherwise the legacy flat/pickup charge applies unchanged.
  let option: ShippingOption | null = null;
  if (!pickup && input.shipping) {
    const quote = await quoteShipping(pub.dataId, { items, address: input.shipping, currency: sf.currency });
    if (quote.rules_active) {
      option = (input.shipping_option_id ? quote.options.find((o) => o.id === input.shipping_option_id) : [...quote.options].sort((a, b) => a.price_minor - b.price_minor)[0]) ?? null;
      if (!option) throw new CheckoutError("no_shipping_option", input.shipping_option_id ? "That shipping option is no longer available. Please choose another." : "We do not ship to this address");
    }
  }
  const shipping = discount?.freeShipping ? 0 : option ? option.price_minor : shippingCharge(sf, pickup);
  const shipTaxBp = option && shipping > 0 ? (sf.settings.shipping_tax_bp ?? 0) : 0;
  const shipTax = Math.round((shipping * shipTaxBp) / 10_000);
  const invoiceLines: LineItem[] = shipping > 0 ? [...orderLines, { description: "Shipping", qty: 1, unit_minor: shipping, tax_rate_bp: shipTaxBp }] : orderLines;
  const goods = await resolveDocumentTotals(pub.dataId, orderLines);
  const baseTotals = combineOrderTotals({ goods, shipping_minor: shipping });
  const totals = shipTax > 0 ? { ...baseTotals, tax_minor: baseTotals.tax_minor + shipTax, total_minor: baseTotals.total_minor + shipTax } : baseTotals;
  if (discount && totals.total_minor <= 0) throw new CheckoutError("discount_invalid", "Discounts cannot reduce an order to zero. Please remove a code or contact the shop.");

  const contact = portalContactId ? { id: portalContactId, created: false } : await matchOrCreateContact(pub.dataId, { name: input.name, email: input.email, phone: input.phone ?? null });
  const consent = input.consent?.marketing === true;

  const order = await insertOrder(pub.dataId, {
    customer_name: input.name,
    customer_email: input.email,
    customer_phone: input.phone ?? null,
    shipping_address: input.shipping ?? null,
    items: orderLines,
    ...totals,
    currency: sf.currency,
    tax_breakdown: goods.breakdown,
    contact_id: contact?.id ?? null,
    cart_id: cart.id,
    consent_marketing: consent,
    notes: input.notes ?? null,
  });

  if (option) await setOrderShipping(pub.dataId, order.id, option.label, toOrderQuote(option)).catch((e) => console.error("[checkout] shipping method not stored:", e));

  // Claim the cart before anything else moves: a second concurrent checkout with the same cookie sees the claim and stops.
  if (!(await claimCartForOrder(cart.id, order.id))) {
    await deleteUnfinishedOrder(pub.dataId, order.id).catch(() => undefined);
    throw new CheckoutError("already_ordered", "This cart has already been checked out");
  }

  try {
    await reserveForOrder(pub.dataId, order.id, goodsLines, { preferLocationId: sf.fulfil_location_id });
  } catch (err) {
    await releaseCartClaim(cart.id, order.id).catch(() => undefined);
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
    await releaseCartClaim(cart.id, order.id).catch(() => undefined);
    await deleteUnfinishedOrder(pub.dataId, order.id).catch(() => undefined);
    throw err;
  }
  await linkOrderInvoice(pub.dataId, order.id, invoiceId);

  // Commit discounts now that the order and invoice exist: redemptions + points debit, then the gift card as a payment line.
  if (discount) {
    try {
      const eng = await import("@/lib/engagement/discounts");
      await eng.commitDiscounts(pub.dataId, discount, { kind: "order", id: order.id }, contact?.id ?? null);
      if (discount.giftCard) await eng.applyGiftCardToInvoice(pub.dataId, invoiceId, { id: discount.giftCard.id, currency: sf.currency }, undefined);
    } catch (err) {
      await rollbackEngagement(pub.dataId, order.id, contact?.id ?? null, discount.points?.points ?? 0);
      await releaseForOrder(pub.dataId, order.id, "Rolled back: discount failed").catch(() => undefined);
      await releaseCartClaim(cart.id, order.id).catch(() => undefined);
      await query(`UPDATE invoices SET status = 'void', updated_at = NOW() WHERE id = $1 AND user_id = $2 AND status = 'sent'`, [invoiceId, pub.dataId]).catch(() => undefined);
      await query(`UPDATE orders SET status = 'cancelled', cancelled_at = NOW(), updated_at = NOW() WHERE id = $1 AND user_id = $2 AND status = 'pending_payment'`, [order.id, pub.dataId]).catch(() => undefined);
      throw new CheckoutError("discount_invalid", err instanceof Error ? err.message : "A discount could not be applied");
    }
  }
  if (input.ref && contact?.id) {
    void import("@/lib/engagement/referrals").then((m) => m.captureReferral(pub.dataId, { code: input.ref as string, refereeContactId: contact.id })).catch(() => undefined);
  }

  // Consent is recorded against the contact only when the checkout created it; an
  // existing contact's ledger is never rewritten by a shopper. The order itself
  // always keeps the box state (consent_marketing).
  if (contact?.created && input.consent?.marketing !== undefined) {
    void recordConsent(pub.dataId, { kind: "contact", id: contact.id }, "marketing_email", consent ? "granted" : "withdrawn", "form", { ...evidence, text: "Storefront checkout" }).catch(() => undefined);
  }

  await setCartEmail(cart.id, input.email).catch(() => undefined);

  const fresh = (await getOrder(pub.dataId, order.id)) ?? order;
  void emitEvent(pub.dataId, {
    type: "order.created",
    entity: "order",
    entityId: order.id,
    data: { number: fresh.number, total_minor: fresh.total_minor, currency: fresh.currency, customer_email: fresh.customer_email, contact_id: fresh.contact_id, invoice_id: invoiceId, lines: goodsLines.length },
  });
  const link = await issueOrderLink(pub.dataId, fresh);
  // A gift card that covered everything leaves nothing to pay: send the shopper to the order page.
  if (fresh.status !== "pending_payment") return { order: fresh, status_url: link.url, status_token: link.token, pay_url: link.url };
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

async function rollbackEngagement(dataId: string, orderId: string, contactId: string | null, points: number): Promise<void> {
  const { rollbackDiscounts } = await import("@/lib/engagement/discounts");
  await rollbackDiscounts(dataId, { kind: "order", id: orderId }, contactId, points);
}
