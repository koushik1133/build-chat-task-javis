import { randomUUID } from "crypto";
import { query, queryOne, withRetry } from "@/lib/dsql";
import { nextDocNumber } from "@/lib/docs/numbering";
import { emitEvent } from "@/lib/events/bus";
import { enqueueNotification } from "@/lib/notifications/outbox";
import { appOrigin, issueShareToken, resolveShareToken } from "@/lib/share-tokens";
import { tableExists } from "@/lib/table-exists";
import { formatMoney, parseItems, type LineItem } from "@/lib/money/items";
import { parseBreakdown, type TaxBreakdownRow } from "@/lib/money/tax";
import { getInvoice, listPayments, voidInvoice, type PaymentRow } from "@/lib/money/invoices";
import { refundPayment } from "@/lib/money/credit-notes";
import { consumeForOrder, releaseForOrder } from "@/lib/inventory/stock";
import { keysetClause, keysetOrder, type Cursor } from "@/lib/public-api/pagination";
import { canTransition, formatAddress, ORDER_STATUS_LABEL, parseShippingAddress, type OrderStatus, type ShippingAddress } from "./pure";
import { getStorefront } from "./settings";

/**
 * Storefront orders. An order is always backed by an invoice (status sent,
 * due now) so accounting, statements and the payment providers see it like
 * any other receivable; payment flows through the invoice and comes back via
 * `markOrderPaidForInvoice` (called from recomputeInvoiceStatus).
 *
 *   pending_payment → paid → fulfilled
 *   pending_payment → cancelled            (reservation released, invoice voided)
 *   paid | fulfilled → refunded            (cancel with refund through the provider)
 */

export interface OrderRow {
  id: string;
  user_id: string;
  number: string;
  status: OrderStatus;
  customer_name: string;
  customer_email: string;
  customer_phone: string | null;
  shipping_address: string | null;
  items: string | null;
  subtotal_minor: string | number;
  tax_minor: string | number;
  shipping_minor: string | number;
  total_minor: string | number;
  currency: string;
  tax_breakdown: string | null;
  contact_id: string | null;
  invoice_id: string | null;
  cart_id: string | null;
  payment_ref: string | null;
  consent_marketing: boolean;
  notes: string | null;
  paid_at: string | Date | null;
  fulfilled_at: string | Date | null;
  cancelled_at: string | Date | null;
  created_at: string | Date;
  updated_at: string | Date;
}

export interface OrderDTO {
  id: string;
  number: string;
  status: OrderStatus;
  status_label: string;
  customer_name: string;
  customer_email: string;
  customer_phone: string | null;
  shipping_address: ShippingAddress | null;
  items: LineItem[];
  subtotal_minor: number;
  tax_minor: number;
  shipping_minor: number;
  total_minor: number;
  currency: string;
  tax_breakdown: TaxBreakdownRow[];
  contact_id: string | null;
  invoice_id: string | null;
  payment_ref: string | null;
  consent_marketing: boolean;
  notes: string | null;
  paid_at: string | null;
  fulfilled_at: string | null;
  cancelled_at: string | null;
  created_at: string;
  updated_at: string;
}

const COLS =
  "id, user_id, number, status, customer_name, customer_email, customer_phone, shipping_address, items, subtotal_minor, tax_minor, shipping_minor, total_minor, currency, tax_breakdown, contact_id, invoice_id, cart_id, payment_ref, consent_marketing, notes, paid_at, fulfilled_at, cancelled_at, created_at, updated_at";

const iso = (v: string | Date | null | undefined): string | null => (v ? new Date(v).toISOString() : null);

export function toOrderDTO(r: OrderRow): OrderDTO {
  return {
    id: r.id,
    number: r.number,
    status: r.status,
    status_label: ORDER_STATUS_LABEL[r.status] ?? r.status,
    customer_name: r.customer_name,
    customer_email: r.customer_email,
    customer_phone: r.customer_phone,
    shipping_address: parseShippingAddress(r.shipping_address),
    items: parseItems(r.items),
    subtotal_minor: Number(r.subtotal_minor),
    tax_minor: Number(r.tax_minor),
    shipping_minor: Number(r.shipping_minor),
    total_minor: Number(r.total_minor),
    currency: r.currency,
    tax_breakdown: parseBreakdown(r.tax_breakdown),
    contact_id: r.contact_id,
    invoice_id: r.invoice_id,
    payment_ref: r.payment_ref,
    consent_marketing: Boolean(r.consent_marketing),
    notes: r.notes,
    paid_at: iso(r.paid_at),
    fulfilled_at: iso(r.fulfilled_at),
    cancelled_at: iso(r.cancelled_at),
    created_at: iso(r.created_at) ?? "",
    updated_at: iso(r.updated_at) ?? "",
  };
}

/** What the customer sees on the public status page: no internal ids. */
export interface PublicOrder {
  number: string;
  status: OrderStatus;
  status_label: string;
  customer_name: string;
  customer_email: string;
  shipping_address: ShippingAddress | null;
  shipping_text: string;
  items: Array<{ description: string; qty: number; unit_minor: number; line_minor: number }>;
  subtotal_minor: number;
  tax_minor: number;
  shipping_minor: number;
  total_minor: number;
  currency: string;
  notes: string | null;
  paid_at: string | null;
  fulfilled_at: string | null;
  cancelled_at: string | null;
  created_at: string;
}

export function toPublicOrder(o: OrderDTO): PublicOrder {
  return {
    number: o.number,
    status: o.status,
    status_label: o.status_label,
    customer_name: o.customer_name,
    customer_email: o.customer_email,
    shipping_address: o.shipping_address,
    shipping_text: formatAddress(o.shipping_address),
    items: o.items.map((i) => ({ description: i.description, qty: i.qty, unit_minor: i.unit_minor, line_minor: Math.round(i.qty * i.unit_minor) })),
    subtotal_minor: o.subtotal_minor,
    tax_minor: o.tax_minor,
    shipping_minor: o.shipping_minor,
    total_minor: o.total_minor,
    currency: o.currency,
    notes: o.notes,
    paid_at: o.paid_at,
    fulfilled_at: o.fulfilled_at,
    cancelled_at: o.cancelled_at,
    created_at: o.created_at,
  };
}

/* ── reads ───────────────────────────────────────────────────────────────── */

export interface ListOrdersOpts {
  status?: OrderStatus | null;
  q?: string | null;
  limit?: number;
  cursor?: Cursor | null;
}

export async function listOrders(dataId: string, opts: ListOrdersOpts = {}): Promise<OrderDTO[]> {
  if (!(await tableExists("orders"))) return [];
  const params: unknown[] = [dataId];
  let sql = `SELECT ${COLS} FROM orders WHERE user_id = $1`;
  if (opts.status) {
    params.push(opts.status);
    sql += ` AND status = $${params.length}`;
  }
  if (opts.q?.trim()) {
    params.push(`%${opts.q.trim().toLowerCase().replace(/[%_\\]/g, "\\$&").slice(0, 100)}%`);
    sql += ` AND (lower(number) LIKE $${params.length} OR lower(customer_email) LIKE $${params.length} OR lower(customer_name) LIKE $${params.length})`;
  }
  sql += keysetClause(opts.cursor, params);
  params.push(Math.min(Math.max(opts.limit ?? 50, 1), 500));
  sql += ` ORDER BY ${keysetOrder()} LIMIT $${params.length}`;
  return (await query<OrderRow>(sql, params)).map(toOrderDTO);
}

export async function getOrder(dataId: string, id: string): Promise<OrderDTO | null> {
  const row = await queryOne<OrderRow>(`SELECT ${COLS} FROM orders WHERE id = $1 AND user_id = $2`, [id, dataId]);
  return row ? toOrderDTO(row) : null;
}

export async function getOrderByInvoice(dataId: string, invoiceId: string): Promise<OrderDTO | null> {
  const row = await queryOne<OrderRow>(`SELECT ${COLS} FROM orders WHERE invoice_id = $1 AND user_id = $2 ORDER BY created_at DESC LIMIT 1`, [invoiceId, dataId]);
  return row ? toOrderDTO(row) : null;
}

export interface OrderCounts {
  pending_payment: number;
  paid: number;
  fulfilled: number;
  cancelled: number;
  refunded: number;
}

export async function orderCounts(dataId: string): Promise<OrderCounts> {
  const out: OrderCounts = { pending_payment: 0, paid: 0, fulfilled: 0, cancelled: 0, refunded: 0 };
  if (!(await tableExists("orders"))) return out;
  const rows = await query<{ status: OrderStatus; n: string | number }>(`SELECT status, COUNT(*) AS n FROM orders WHERE user_id = $1 GROUP BY status`, [dataId]);
  for (const r of rows) if (r.status in out) out[r.status] = Number(r.n);
  return out;
}

/* ── create ──────────────────────────────────────────────────────────────── */

export interface CreateOrderInput {
  customer_name: string;
  customer_email: string;
  customer_phone?: string | null;
  shipping_address?: ShippingAddress | null;
  items: LineItem[];
  subtotal_minor: number;
  tax_minor: number;
  shipping_minor: number;
  total_minor: number;
  currency: string;
  tax_breakdown: TaxBreakdownRow[];
  contact_id?: string | null;
  cart_id?: string | null;
  consent_marketing: boolean;
  notes?: string | null;
}

/** Insert a pending order with the next ORD number. Stock/invoice linking happens in checkout.ts. */
export async function insertOrder(dataId: string, input: CreateOrderInput): Promise<OrderDTO> {
  const id = randomUUID();
  const number = await nextDocNumber(dataId, "order");
  await query(
    `INSERT INTO orders (id, user_id, number, status, customer_name, customer_email, customer_phone, shipping_address, items, subtotal_minor, tax_minor, shipping_minor, total_minor,
       currency, tax_breakdown, contact_id, cart_id, consent_marketing, notes)
     VALUES ($1, $2, $3, 'pending_payment', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
    [
      id, dataId, number, input.customer_name.trim().slice(0, 200), input.customer_email.trim().toLowerCase(), input.customer_phone?.trim() || null,
      input.shipping_address ? JSON.stringify(input.shipping_address) : null, JSON.stringify(input.items), input.subtotal_minor, input.tax_minor, input.shipping_minor, input.total_minor,
      input.currency.toUpperCase(), JSON.stringify(input.tax_breakdown), input.contact_id ?? null, input.cart_id ?? null, input.consent_marketing, input.notes?.trim() || null,
    ]
  );
  const o = await getOrder(dataId, id);
  if (!o) throw new Error("Order vanished after insert");
  return o;
}

export async function linkOrderInvoice(dataId: string, orderId: string, invoiceId: string): Promise<void> {
  await query(`UPDATE orders SET invoice_id = $3, updated_at = NOW() WHERE id = $1 AND user_id = $2`, [orderId, dataId, invoiceId]);
}

export async function deleteUnfinishedOrder(dataId: string, orderId: string): Promise<void> {
  await query(`DELETE FROM orders WHERE id = $1 AND user_id = $2 AND status = 'pending_payment' AND invoice_id IS NULL`, [orderId, dataId]);
}

/* ── public link ─────────────────────────────────────────────────────────── */

/** Recipient-bound status link: /shop/<slug>/order/<token>. */
export async function issueOrderLink(dataId: string, order: OrderDTO, ttlDays = 90): Promise<{ token: string; url: string; path: string }> {
  const sf = await getStorefront(dataId);
  const share = await issueShareToken(dataId, "order", order.id, ttlDays, { recipient: order.customer_email });
  const path = `/shop/${encodeURIComponent(sf.slug)}/order/${share.token}`;
  return { token: share.token, path, url: `${appOrigin()}${path}` };
}

/** Resolve a public order token for an org; null when unknown/expired or belonging to another org. */
export async function resolveOrderToken(dataId: string, token: string): Promise<OrderDTO | null> {
  const share = await resolveShareToken("order", token);
  if (!share || share.user_id !== dataId) return null;
  return getOrder(dataId, share.entity_id);
}

/* ── transitions ─────────────────────────────────────────────────────────── */

async function setStatus(dataId: string, id: string, from: OrderStatus, to: OrderStatus, extra: Record<string, unknown> = {}): Promise<boolean> {
  const sets = ["status = $4", "updated_at = NOW()"];
  const params: unknown[] = [id, dataId, from, to];
  for (const [k, v] of Object.entries(extra)) {
    params.push(v);
    sets.push(`${k} = $${params.length}`);
  }
  const rows = await withRetry(() => query<{ id: string }>(`UPDATE orders SET ${sets.join(", ")} WHERE id = $1 AND user_id = $2 AND status = $3 RETURNING id`, params));
  return rows.length > 0;
}

async function shopName(dataId: string): Promise<string> {
  const sf = await getStorefront(dataId);
  if (sf.title) return sf.title;
  const org = await queryOne<{ name: string }>(`SELECT name FROM organizations WHERE owner_user_id = $1 ORDER BY created_at ASC LIMIT 1`, [dataId]).catch(() => null);
  return org?.name ?? "Our shop";
}

function itemLines(o: OrderDTO): string {
  return o.items.map((i) => `  ${i.qty} × ${i.description} — ${formatMoney(Math.round(i.qty * i.unit_minor), o.currency)}`).join("\n");
}

/**
 * Called from recomputeInvoiceStatus when an invoice flips to paid. Consumes
 * stock against the order reservation, marks the order paid and emails the
 * confirmation. Safe to call for invoices that have no order (no-op).
 */
export async function markOrderPaidForInvoice(dataId: string, invoiceId: string): Promise<OrderDTO | null> {
  if (!(await tableExists("orders"))) return null;
  const order = await getOrderByInvoice(dataId, invoiceId);
  if (!order || order.status !== "pending_payment") return order;
  const payments = await listPayments(invoiceId).catch(() => [] as PaymentRow[]);
  const succeeded = payments.filter((p) => p.status === "succeeded").pop();
  const moved = await setStatus(dataId, order.id, "pending_payment", "paid", { paid_at: new Date().toISOString(), payment_ref: succeeded?.provider_ref ?? null });
  if (!moved) return getOrder(dataId, order.id);
  try {
    await consumeForOrder(dataId, order.id, invoiceId, order.items);
  } catch (err) {
    console.error(`[orders] stock consumption failed for ${order.id}:`, err);
  }
  const fresh = (await getOrder(dataId, order.id)) ?? order;
  void emitEvent(dataId, { type: "order.paid", entity: "order", entityId: order.id, data: { number: order.number, total_minor: order.total_minor, currency: order.currency, customer_email: order.customer_email, contact_id: order.contact_id, invoice_id: invoiceId } });
  try {
    const from = await shopName(dataId);
    const link = await issueOrderLink(dataId, fresh);
    await enqueueNotification(dataId, {
      channel: "email",
      recipient: fresh.customer_email,
      subject: `Order ${fresh.number} confirmed — ${from}`,
      body:
        `Hi ${fresh.customer_name},\n\nThanks for your order. We have received your payment of ${formatMoney(fresh.total_minor, fresh.currency)}.\n\n` +
        `${itemLines(fresh)}\n\n` +
        (fresh.shipping_address ? `Shipping to: ${formatAddress(fresh.shipping_address)}\n\n` : `Collection: we will let you know when it is ready to pick up.\n\n`) +
        `Track your order: ${link.url}\n\n${from}`,
      data: { kind: "order_confirmation", category: "orders", order_id: fresh.id, number: fresh.number, url: link.url },
    });
  } catch (err) {
    console.error(`[orders] confirmation email failed for ${order.id}:`, err);
  }
  return fresh;
}

export async function fulfillOrder(dataId: string, id: string, actorId?: string | null, opts: { notify?: boolean } = {}): Promise<OrderDTO> {
  const order = await getOrder(dataId, id);
  if (!order) throw new Error("Order not found");
  if (order.status === "fulfilled") return order;
  if (!canTransition(order.status, "fulfilled")) throw new Error(`Order is ${order.status_label.toLowerCase()} and cannot be fulfilled`);
  const moved = await setStatus(dataId, id, order.status, "fulfilled", { fulfilled_at: new Date().toISOString() });
  if (!moved) throw new Error("Order changed while fulfilling; reload and try again");
  const fresh = (await getOrder(dataId, id)) ?? order;
  void emitEvent(dataId, { type: "order.fulfilled", entity: "order", entityId: id, data: { number: order.number, customer_email: order.customer_email, contact_id: order.contact_id, actor: actorId ?? null } });
  if (opts.notify === false) return fresh; // shipping lane sends its own dispatch email with the tracking link
  try {
    const from = await shopName(dataId);
    const link = await issueOrderLink(dataId, fresh);
    await enqueueNotification(dataId, {
      channel: "email",
      recipient: fresh.customer_email,
      subject: `Order ${fresh.number} is on its way — ${from}`,
      body:
        `Hi ${fresh.customer_name},\n\n` +
        (fresh.shipping_address ? `Your order has been dispatched to ${formatAddress(fresh.shipping_address)}.\n\n` : `Your order is ready for collection.\n\n`) +
        `${itemLines(fresh)}\n\nOrder details: ${link.url}\n\n${from}`,
      data: { kind: "order_fulfilled", category: "orders", order_id: fresh.id, number: fresh.number, url: link.url },
    });
  } catch (err) {
    console.error(`[orders] fulfilment email failed for ${id}:`, err);
  }
  return fresh;
}

/** Undo a mistaken fulfilment: fulfilled → paid. Refunded/cancelled orders cannot be reopened. */
export async function unfulfillOrder(dataId: string, id: string, actorId?: string | null): Promise<OrderDTO> {
  const order = await getOrder(dataId, id);
  if (!order) throw new Error("Order not found");
  if (order.status === "paid") return order;
  if (order.status !== "fulfilled") throw new Error(`Order is ${order.status_label.toLowerCase()} and cannot be marked unfulfilled`);
  const moved = await setStatus(dataId, id, "fulfilled", "paid", { fulfilled_at: null });
  if (!moved) throw new Error("Order changed while updating; reload and try again");
  const fresh = (await getOrder(dataId, id)) ?? order;
  void emitEvent(dataId, { type: "order.unfulfilled", entity: "order", entityId: id, data: { number: order.number, customer_email: order.customer_email, contact_id: order.contact_id, actor: actorId ?? null } });
  return fresh;
}

export interface CancelResult {
  order: OrderDTO;
  released: number;
  refunded_minor: number;
}

/**
 * Cancel an order. Pending: release the reservation and void the invoice.
 * Paid/fulfilled: refund every succeeded payment through its provider (the
 * order ends `refunded`); stock already consumed is received back only when
 * `restock` is set (goods never left or came back).
 */
export async function cancelOrder(dataId: string, id: string, opts: { reason?: string | null; restock?: boolean; actorId?: string | null } = {}): Promise<CancelResult> {
  const order = await getOrder(dataId, id);
  if (!order) throw new Error("Order not found");
  if (order.status === "cancelled" || order.status === "refunded") return { order, released: 0, refunded_minor: 0 };
  let refunded = 0;
  let released = 0;
  if (order.status === "pending_payment") {
    const moved = await setStatus(dataId, id, "pending_payment", "cancelled", { cancelled_at: new Date().toISOString() });
    if (!moved) throw new Error("Order changed while cancelling; reload and try again");
    released = (await releaseForOrder(dataId, id, "Order cancelled")).length;
    if (order.invoice_id) await voidInvoice(dataId, order.invoice_id).catch((err) => console.error(`[orders] void invoice failed for ${id}:`, err));
  } else {
    if (!canTransition(order.status, "refunded")) throw new Error(`Order is ${order.status_label.toLowerCase()} and cannot be cancelled`);
    refunded = await refundOrder(dataId, order, { reason: opts.reason ?? "Order cancelled" });
    // A full refund already moved the order to `refunded`; otherwise close it here.
    const after = (await getOrder(dataId, id)) ?? order;
    if (after.status !== "refunded") {
      const moved = await setStatus(dataId, id, after.status, "refunded", { cancelled_at: new Date().toISOString() });
      if (!moved) throw new Error("Order changed while cancelling; reload and try again");
    }
    if (opts.restock) {
      const { adjustStock } = await import("@/lib/inventory/stock");
      for (const it of order.items) {
        if (!it.product_id) continue;
        const qty = Math.ceil(Number(it.qty) || 0);
        if (qty > 0) await adjustStock(dataId, it.product_id, { kind: "receive", qty, ref_kind: "order", ref_id: id, note: "Order cancelled: restocked" }, opts.actorId ?? null).catch(() => undefined);
      }
    }
  }
  const fresh = (await getOrder(dataId, id)) ?? order;
  void emitEvent(dataId, { type: "order.cancelled", entity: "order", entityId: id, data: { number: order.number, previous_status: order.status, refunded_minor: refunded, released, reason: opts.reason ?? null, customer_email: order.customer_email, contact_id: order.contact_id } });
  return { order: fresh, released, refunded_minor: refunded };
}

/** Refund up to `amount_minor` (default: everything refundable) across the linked invoice's payments via the existing refund path. */
export async function refundOrder(dataId: string, order: OrderDTO, opts: { amount_minor?: number | null; reason?: string | null } = {}): Promise<number> {
  if (!order.invoice_id) throw new Error("Order has no invoice to refund");
  const inv = await getInvoice(dataId, order.invoice_id);
  if (!inv) throw new Error("Invoice not found");
  const payments = (await listPayments(inv.id)).filter((p) => p.status === "succeeded");
  let remaining = opts.amount_minor ?? payments.reduce((s, p) => s + Number(p.amount_minor) - Number(p.refunded_minor ?? 0), 0);
  if (!Number.isInteger(remaining) || remaining <= 0) return 0;
  let done = 0;
  for (const p of payments) {
    if (remaining <= 0) break;
    const refundable = Number(p.amount_minor) - Number(p.refunded_minor ?? 0);
    if (refundable <= 0) continue;
    const amount = Math.min(refundable, remaining);
    await refundPayment(dataId, inv.id, { paymentId: p.id, amount_minor: amount, reason: opts.reason ?? null });
    remaining -= amount;
    done += amount;
  }
  if (done > 0) {
    // A full refund closes the order; a partial one leaves it where it is.
    const fresh = await getOrder(dataId, order.id);
    const totalRefunded = (await listPayments(inv.id)).reduce((s, p) => s + Number(p.refunded_minor ?? 0), 0);
    if (fresh && totalRefunded >= fresh.total_minor && canTransition(fresh.status, "refunded")) {
      await setStatus(dataId, order.id, fresh.status, "refunded", { cancelled_at: new Date().toISOString() });
    }
  }
  return done;
}
