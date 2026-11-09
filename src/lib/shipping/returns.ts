import { randomUUID } from "crypto";
import { z } from "zod";
import { query, queryOne, isUndefinedColumn } from "@/lib/dsql";
import { emitEvent } from "@/lib/events/bus";
import { enqueueNotification } from "@/lib/notifications/outbox";
import { tableExists } from "@/lib/table-exists";
import { recordAudit } from "@/lib/audit";
import { getBranding } from "@/lib/branding";
import { appOrigin } from "@/lib/share-tokens";
import { adjustStock } from "@/lib/inventory/stock";
import { getInvoice, listPayments } from "@/lib/money/invoices";
import { formatMoney } from "@/lib/money/items";
import { getOrder, refundOrder, type OrderDTO } from "@/lib/storefront/orders";
import { getStorefront } from "@/lib/storefront/settings";
import { keysetClause, keysetOrder, type Cursor } from "@/lib/public-api/pagination";
import { DEFAULT_RETURN_WINDOW_DAYS, cappedRefund, returnLinesValue, withinReturnWindow } from "./rules";
import { insertReturnShipment, issueTrackingLink, listShipments, type ShipmentDTO, type ShipmentItem } from "./shipments";
import { RETURN_RESOLUTIONS, RETURN_STATUSES, ShippingError, parseJson, type ReturnResolution, type ReturnStatus } from "./types";

/** Returns: customer request → staff decision → label/instructions → received (+restock) → refund / store credit. */

export interface ReturnLine {
  product_id?: string | null;
  description: string;
  qty: number;
}

interface ReturnRow {
  id: string;
  user_id: string;
  order_id: string;
  contact_id: string | null;
  status: ReturnStatus;
  reason: string | null;
  items: string | null;
  resolution: ReturnResolution;
  notes: string | null;
  refund_minor: string | number;
  created_at: string | Date;
  updated_at: string | Date;
}

export interface ReturnDTO {
  id: string;
  order_id: string;
  order_number: string | null;
  contact_id: string | null;
  status: ReturnStatus;
  reason: string | null;
  items: ReturnLine[];
  resolution: ReturnResolution;
  notes: string | null;
  refund_minor: number;
  created_at: string;
  updated_at: string;
}

const COLS = "id, user_id, order_id, contact_id, status, reason, items, resolution, notes, refund_minor, created_at, updated_at";
const iso = (v: string | Date): string => new Date(v).toISOString();

function toDTO(r: ReturnRow, orderNumber: string | null = null): ReturnDTO {
  return { id: r.id, order_id: r.order_id, order_number: orderNumber, contact_id: r.contact_id, status: r.status, reason: r.reason, items: parseJson<ReturnLine[]>(r.items, []), resolution: r.resolution, notes: r.notes, refund_minor: Number(r.refund_minor), created_at: iso(r.created_at), updated_at: iso(r.updated_at) };
}

export async function listReturns(dataId: string, opts: { status?: ReturnStatus | null; orderId?: string | null; limit?: number; cursor?: Cursor | null } = {}): Promise<ReturnDTO[]> {
  if (!(await tableExists("return_requests"))) return [];
  const params: unknown[] = [dataId];
  let sql = `SELECT ${COLS} FROM return_requests WHERE user_id = $1`;
  if (opts.status) { params.push(opts.status); sql += ` AND status = $${params.length}`; }
  if (opts.orderId) { params.push(opts.orderId); sql += ` AND order_id = $${params.length}`; }
  sql += keysetClause(opts.cursor, params);
  params.push(Math.min(Math.max(opts.limit ?? 50, 1), 500));
  sql += ` ORDER BY ${keysetOrder()} LIMIT $${params.length}`;
  const rows = await query<ReturnRow>(sql, params);
  const numbers = new Map<string, string>();
  const ids = [...new Set(rows.map((r) => r.order_id))];
  if (ids.length > 0) for (const o of await query<{ id: string; number: string }>(`SELECT id, number FROM orders WHERE user_id = $1 AND id = ANY($2::text[])`, [dataId, ids])) numbers.set(o.id, o.number);
  return rows.map((r) => toDTO(r, numbers.get(r.order_id) ?? null));
}

export async function getReturn(dataId: string, id: string): Promise<ReturnDTO | null> {
  const r = await queryOne<ReturnRow>(`SELECT ${COLS} FROM return_requests WHERE id = $1 AND user_id = $2`, [id, dataId]);
  if (!r) return null;
  const o = await queryOne<{ number: string }>(`SELECT number FROM orders WHERE id = $1 AND user_id = $2`, [r.order_id, dataId]);
  return toDTO(r, o?.number ?? null);
}

/* ── window ────────────────────────────────────────────────────────────── */

export async function returnWindowDays(dataId: string): Promise<number> {
  try {
    const r = await queryOne<{ return_window_days: number | null }>(`SELECT return_window_days FROM storefronts WHERE user_id = $1`, [dataId]);
    const d = r?.return_window_days;
    return typeof d === "number" && d >= 0 && d <= 365 ? d : DEFAULT_RETURN_WINDOW_DAYS;
  } catch (err) {
    if (isUndefinedColumn(err)) return DEFAULT_RETURN_WINDOW_DAYS;
    throw err;
  }
}

export async function setReturnWindowDays(dataId: string, days: number): Promise<void> {
  await getStorefront(dataId); // storefront row is created by the Orders page; only update an existing one
  await query(`UPDATE storefronts SET return_window_days = $2, updated_at = NOW() WHERE user_id = $1`, [dataId, Math.min(Math.max(Math.trunc(days), 0), 365)]);
}

/** Return window anchor: the latest delivery, else fulfilment, else payment. */
async function anchorFor(dataId: string, order: OrderDTO): Promise<string | null> {
  const delivered = (await listShipments(dataId, { orderId: order.id, limit: 20 })).filter((s) => !s.return_id && s.delivered_at).map((s) => s.delivered_at as string).sort();
  return delivered[delivered.length - 1] ?? order.fulfilled_at ?? order.paid_at;
}

export async function returnEligibility(dataId: string, order: OrderDTO, now = new Date()): Promise<{ eligible: boolean; reason: string | null; window_days: number; deadline: string | null; days_left: number }> {
  const window_days = await returnWindowDays(dataId);
  if (order.status !== "paid" && order.status !== "fulfilled") return { eligible: false, reason: "Only paid orders can be returned", window_days, deadline: null, days_left: 0 };
  if (!order.shipping_address) return { eligible: false, reason: "Collection orders are returned in person", window_days, deadline: null, days_left: 0 };
  const w = withinReturnWindow(await anchorFor(dataId, order), window_days, now);
  if (!w.ok) return { eligible: false, reason: `The ${window_days}-day return window has passed`, window_days, deadline: w.deadline, days_left: 0 };
  return { eligible: true, reason: null, window_days, deadline: w.deadline, days_left: w.days_left };
}

/* ── create ────────────────────────────────────────────────────────────── */

export const ReturnRequestSchema = z
  .object({
    reason: z.string().trim().min(1).max(1000),
    resolution: z.enum(RETURN_RESOLUTIONS).optional(),
    items: z.array(z.object({ product_id: z.string().max(100).nullable().optional(), description: z.string().trim().max(300).optional(), qty: z.number().int().min(1).max(100_000) }).strict()).min(1).max(50),
  })
  .strict();
export type ReturnRequestInput = z.infer<typeof ReturnRequestSchema>;

async function alreadyReturned(dataId: string, orderId: string): Promise<Map<string, number>> {
  const used = new Map<string, number>();
  const rows = await query<ReturnRow>(`SELECT ${COLS} FROM return_requests WHERE user_id = $1 AND order_id = $2 AND status NOT IN ('rejected','closed')`, [dataId, orderId]);
  for (const r of rows) for (const l of parseJson<ReturnLine[]>(r.items, [])) used.set(l.product_id ?? l.description, (used.get(l.product_id ?? l.description) ?? 0) + l.qty);
  return used;
}

/** Validate lines against the order: must exist, and quantity ≤ ordered − already in an open/finished return. */
export async function normalizeReturnLines(dataId: string, order: OrderDTO, lines: ReturnRequestInput["items"]): Promise<ReturnLine[]> {
  const used = await alreadyReturned(dataId, order.id);
  const out: ReturnLine[] = [];
  for (const l of lines) {
    const match = order.items.find((o) => (l.product_id ? o.product_id === l.product_id : o.description === l.description));
    if (!match) throw new ShippingError("invalid", "One of the items is not on this order");
    const key = match.product_id ?? match.description;
    const room = Math.floor(match.qty) - (used.get(key) ?? 0) - out.filter((x) => (x.product_id ?? x.description) === key).reduce((s, x) => s + x.qty, 0);
    if (l.qty > room) throw new ShippingError("invalid", room <= 0 ? `"${match.description}" has already been returned` : `You can return at most ${room} of "${match.description}"`);
    out.push({ product_id: match.product_id ?? null, description: match.description, qty: l.qty });
  }
  return out;
}

async function mail(dataId: string, order: OrderDTO, subject: string, text: string, kind: string, extra: Record<string, unknown> = {}): Promise<void> {
  try {
    const sf = await getStorefront(dataId);
    const b = await getBranding(dataId).catch(() => null);
    const from = sf.title ?? b?.brand_name ?? "Our shop";
    await enqueueNotification(dataId, { channel: "email", recipient: order.customer_email, subject: `${subject} — ${from}`, body: `Hi ${order.customer_name},\n\n${text}\n\n${from}`, data: { kind, category: "orders", order_id: order.id, number: order.number, ...extra } });
  } catch (err) {
    console.error(`[returns] ${kind} email failed:`, err);
  }
}

/** Customer (or staff on their behalf) opens a return. Enforces the window, order state and per-line quantity. */
export async function createReturnRequest(dataId: string, orderId: string, input: ReturnRequestInput, opts: { source: "customer" | "staff"; actorId?: string | null; now?: Date } = { source: "customer" }): Promise<ReturnDTO> {
  const order = await getOrder(dataId, orderId);
  if (!order) throw new ShippingError("not_found", "Order not found", 404);
  const el = await returnEligibility(dataId, order, opts.now);
  if (!el.eligible && !(opts.source === "staff" && order.shipping_address && (order.status === "paid" || order.status === "fulfilled"))) {
    throw new ShippingError(el.reason?.includes("window") ? "return_window" : "conflict", el.reason ?? "This order cannot be returned", 409);
  }
  const lines = await normalizeReturnLines(dataId, order, input.items);
  const id = randomUUID();
  await query(`INSERT INTO return_requests (id, user_id, order_id, contact_id, status, reason, items, resolution) VALUES ($1,$2,$3,$4,'requested',$5,$6,$7)`, [id, dataId, orderId, order.contact_id, input.reason, JSON.stringify(lines), input.resolution ?? "refund"]);
  void emitEvent(dataId, { type: "return.requested", entity: "return", entityId: id, data: { order_id: orderId, number: order.number, customer_email: order.customer_email, contact_id: order.contact_id, lines: lines.length, source: opts.source } });
  void recordAudit({ dataId, userId: opts.actorId ?? null }, { action: "return.requested", entity: "return", entityId: id, after: { order_id: orderId, source: opts.source } });
  await mail(dataId, order, `We received your return request for ${order.number}`, "We have received your return request and will review it shortly. You will get another email when it is approved.", "return_requested", { return_id: id });
  return (await getReturn(dataId, id)) as ReturnDTO;
}

/* ── staff workflow ────────────────────────────────────────────────────── */

async function load(dataId: string, id: string): Promise<{ ret: ReturnDTO; order: OrderDTO }> {
  const ret = await getReturn(dataId, id);
  if (!ret) throw new ShippingError("not_found", "Return not found", 404);
  const order = await getOrder(dataId, ret.order_id);
  if (!order) throw new ShippingError("not_found", "Order not found", 404);
  return { ret, order };
}

async function move(dataId: string, id: string, from: ReturnStatus[], to: ReturnStatus, extra: { notes?: string | null; refund_minor?: number; resolution?: ReturnResolution } = {}): Promise<boolean> {
  const sets = ["status = $4", "updated_at = NOW()"];
  const params: unknown[] = [id, dataId, from, to];
  if (extra.notes !== undefined) { params.push(extra.notes); sets.push(`notes = $${params.length}`); }
  if (extra.refund_minor !== undefined) { params.push(extra.refund_minor); sets.push(`refund_minor = $${params.length}`); }
  if (extra.resolution !== undefined) { params.push(extra.resolution); sets.push(`resolution = $${params.length}`); }
  return (await query<{ id: string }>(`UPDATE return_requests SET ${sets.join(", ")} WHERE id = $1 AND user_id = $2 AND status = ANY($3::text[]) RETURNING id`, params)).length > 0;
}

const appendNote = (cur: string | null, add: string | null | undefined): string | null => (add?.trim() ? [cur, add.trim()].filter(Boolean).join("\n") : cur);

export async function decideReturn(dataId: string, id: string, decision: "approve" | "reject", opts: { notes?: string | null; resolution?: ReturnResolution; actorId?: string | null } = {}): Promise<ReturnDTO> {
  const { ret, order } = await load(dataId, id);
  const to: ReturnStatus = decision === "approve" ? "approved" : "rejected";
  if (ret.status === to) return ret;
  if (!(await move(dataId, id, ["requested"], to, { notes: appendNote(ret.notes, opts.notes), resolution: opts.resolution }))) throw new ShippingError("conflict", `Return is ${ret.status}; only requested returns can be ${to}`, 409);
  if (decision === "approve") {
    void emitEvent(dataId, { type: "return.approved", entity: "return", entityId: id, data: { order_id: order.id, number: order.number, customer_email: order.customer_email, contact_id: order.contact_id } });
    await mail(dataId, order, `Your return for ${order.number} is approved`, "Your return has been approved. We will send you a prepaid label or return instructions shortly.", "return_approved", { return_id: id });
  } else {
    await mail(dataId, order, `Update on your return for ${order.number}`, `We are unable to accept this return.${opts.notes?.trim() ? `\n\n${opts.notes.trim()}` : ""}`, "return_rejected", { return_id: id });
  }
  void recordAudit({ dataId, userId: opts.actorId ?? null }, { action: `return.${to}`, entity: "return", entityId: id, after: { notes: opts.notes ?? null } });
  return (await getReturn(dataId, id)) as ReturnDTO;
}

/** Approved → label_sent: a reverse shipment (provider label or manual), or plain instructions text. */
export async function sendReturnLabel(dataId: string, id: string, opts: { provider?: string; manual?: { carrier: string; tracking_number?: string; tracking_url?: string }; instructions?: string; actorId?: string | null } = {}): Promise<{ ret: ReturnDTO; shipment: ShipmentDTO | null }> {
  const { ret, order } = await load(dataId, id);
  if (ret.status !== "approved" && ret.status !== "label_sent") throw new ShippingError("conflict", `Return is ${ret.status}; approve it first`, 409);
  let shipment: ShipmentDTO | null = null;
  let body: string;
  if (opts.instructions?.trim() && !opts.manual && !opts.provider) {
    body = `Your return is approved. Please follow these instructions:\n\n${opts.instructions.trim()}`;
  } else {
    const items: ShipmentItem[] = ret.items.map((l) => ({ product_id: l.product_id ?? null, description: l.description, qty: l.qty }));
    shipment = await insertReturnShipment(dataId, id, order, { provider: opts.provider, manual: opts.manual, items, actorId: opts.actorId });
    const link = await issueTrackingLink(dataId, shipment.id, order.customer_email, 60);
    body = `Your return is approved. Print your return label here:\n${link.url}\n\n${shipment.carrier ? `Carrier: ${shipment.carrier}${shipment.tracking_number ? ` (tracking ${shipment.tracking_number})` : ""}\n` : ""}${opts.instructions?.trim() ?? ""}`.trim();
  }
  await move(dataId, id, ["approved", "label_sent"], "label_sent", { notes: appendNote(ret.notes, opts.instructions) });
  await mail(dataId, order, `Return label for ${order.number}`, body, "return_label", { return_id: id });
  void recordAudit({ dataId, userId: opts.actorId ?? null }, { action: "return.label_sent", entity: "return", entityId: id, after: { shipment_id: shipment?.id ?? null } });
  return { ret: (await getReturn(dataId, id)) as ReturnDTO, shipment };
}

/** Goods arrived. `restock` receives the returned lines back into inventory. */
export async function markReturnReceived(dataId: string, id: string, opts: { restock?: boolean; actorId?: string | null } = {}): Promise<ReturnDTO> {
  const { ret } = await load(dataId, id);
  if (ret.status === "received") return ret;
  if (!(await move(dataId, id, ["approved", "label_sent"], "received"))) throw new ShippingError("conflict", `Return is ${ret.status}; it must be approved before it is received`, 409);
  if (opts.restock) {
    for (const l of ret.items) {
      if (!l.product_id) continue;
      await adjustStock(dataId, l.product_id, { kind: "receive", qty: l.qty, ref_kind: "return", ref_id: id, note: "Customer return: restocked" }, opts.actorId ?? null).catch((e) => console.error("[returns] restock failed:", e));
    }
  }
  void recordAudit({ dataId, userId: opts.actorId ?? null }, { action: "return.received", entity: "return", entityId: id, after: { restock: Boolean(opts.restock) } });
  return (await getReturn(dataId, id)) as ReturnDTO;
}

/** What is still refundable on the order's payments. */
export async function refundableMinor(order: OrderDTO, dataId: string): Promise<{ paid: number; refunded: number }> {
  if (!order.invoice_id) return { paid: 0, refunded: 0 };
  const inv = await getInvoice(dataId, order.invoice_id);
  if (!inv) return { paid: 0, refunded: 0 };
  const pays = (await listPayments(inv.id)).filter((p) => p.status === "succeeded");
  return { paid: pays.reduce((s, p) => s + Number(p.amount_minor), 0), refunded: pays.reduce((s, p) => s + Number(p.refunded_minor ?? 0), 0) };
}

/** Suggested refund: returned lines at paid prices plus their share of tax. */
export function suggestedRefund(order: OrderDTO, lines: ReturnLine[]): number {
  const goods = returnLinesValue(order.items, lines);
  const share = order.subtotal_minor > 0 ? order.tax_minor / order.subtotal_minor : 0;
  return Math.round(goods * (1 + share));
}

export async function refundReturn(dataId: string, id: string, opts: { amount_minor?: number; resolution?: ReturnResolution; actorId?: string | null } = {}): Promise<{ ret: ReturnDTO; refunded_minor: number }> {
  const { ret, order } = await load(dataId, id);
  if (ret.status === "refunded") return { ret, refunded_minor: ret.refund_minor };
  if (ret.status !== "received") throw new ShippingError("conflict", `Return is ${ret.status}; mark it received before refunding`, 409);
  const resolution = opts.resolution ?? ret.resolution;
  const requested = opts.amount_minor ?? suggestedRefund(order, ret.items);
  const { paid, refunded } = await refundableMinor(order, dataId);
  const amount = resolution === "exchange" ? 0 : cappedRefund(requested, paid, refunded);
  if (resolution === "refund") {
    if (amount <= 0) throw new ShippingError("invalid", "Nothing left to refund on this order", 409);
    // The conditional move first: a double click must not refund twice.
    if (!(await move(dataId, id, ["received"], "refunded", { refund_minor: amount, resolution }))) throw new ShippingError("conflict", "Return changed; reload and try again", 409);
    try {
      const done = await refundOrder(dataId, order, { amount_minor: amount, reason: `Return ${id.slice(0, 8)}` });
      if (done !== amount) await query(`UPDATE return_requests SET refund_minor = $3 WHERE id = $1 AND user_id = $2`, [id, dataId, done]);
    } catch (err) {
      await move(dataId, id, ["refunded"], "received", { refund_minor: 0 }).catch(() => undefined);
      throw err;
    }
  } else if (resolution === "store_credit") {
    if (!(await move(dataId, id, ["received"], "refunded", { refund_minor: amount, resolution, notes: appendNote(ret.notes, `Store credit of ${formatMoney(amount, order.currency)} to be issued`) }))) throw new ShippingError("conflict", "Return changed; reload and try again", 409);
  } else if (!(await move(dataId, id, ["received"], "closed", { resolution, notes: appendNote(ret.notes, "Exchange: replacement to be sent") }))) {
    throw new ShippingError("conflict", "Return changed; reload and try again", 409);
  }
  const fresh = (await getReturn(dataId, id)) as ReturnDTO;
  if (resolution !== "exchange") {
    void emitEvent(dataId, { type: "return.refunded", entity: "return", entityId: id, data: { order_id: order.id, number: order.number, resolution, refund_minor: fresh.refund_minor, currency: order.currency, customer_email: order.customer_email, contact_id: order.contact_id } });
    await mail(dataId, order, `Your return for ${order.number} is complete`, resolution === "refund" ? `We have refunded ${formatMoney(fresh.refund_minor, order.currency)} to your original payment method.` : `We will issue store credit of ${formatMoney(fresh.refund_minor, order.currency)}.`, "return_refunded", { return_id: id });
  }
  void recordAudit({ dataId, userId: opts.actorId ?? null }, { action: "return.refunded", entity: "return", entityId: id, after: { resolution, refund_minor: fresh.refund_minor } });
  return { ret: fresh, refunded_minor: fresh.refund_minor };
}

export async function closeReturn(dataId: string, id: string): Promise<ReturnDTO> {
  const ret = await getReturn(dataId, id);
  if (!ret) throw new ShippingError("not_found", "Return not found", 404);
  if (ret.status === "closed") return ret;
  await move(dataId, id, ["rejected", "refunded", "requested", "approved", "label_sent", "received"], "closed");
  return (await getReturn(dataId, id)) as ReturnDTO;
}

/** Public view of an order's returns (no internal notes). */
export async function publicReturnsForOrder(dataId: string, orderId: string): Promise<Array<{ id: string; status: ReturnStatus; reason: string | null; items: ReturnLine[]; resolution: ReturnResolution; refund_minor: number; created_at: string }>> {
  return (await listReturns(dataId, { orderId, limit: 20 })).map((r) => ({ id: r.id, status: r.status, reason: r.reason, items: r.items, resolution: r.resolution, refund_minor: r.refund_minor, created_at: r.created_at }));
}

export function returnPortalUrl(path: string): string {
  return `${appOrigin()}${path}`;
}

export { RETURN_STATUSES };

export interface PublicReturnInfo {
  eligible: boolean;
  reason: string | null;
  window_days: number;
  deadline: string | null;
  /** Lines the customer can still return (ordered − already requested). */
  lines: Array<{ product_id: string | null; description: string; qty_available: number }>;
  existing: Awaited<ReturnType<typeof publicReturnsForOrder>>;
}

/** What the customer's order page and portal need to render the return form. */
export async function publicReturnInfo(dataId: string, order: OrderDTO): Promise<PublicReturnInfo> {
  const [el, used, existing] = await Promise.all([returnEligibility(dataId, order), alreadyReturned(dataId, order.id), publicReturnsForOrder(dataId, order.id)]);
  const lines = order.items
    .map((i) => ({ product_id: i.product_id ?? null, description: i.description, qty_available: Math.max(0, Math.floor(i.qty) - (used.get(i.product_id ?? i.description) ?? 0)) }))
    .filter((l) => l.qty_available > 0);
  return { eligible: el.eligible && lines.length > 0, reason: el.eligible && lines.length === 0 ? "Everything on this order is already in a return" : el.reason, window_days: el.window_days, deadline: el.deadline, lines, existing };
}
