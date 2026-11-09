import { randomUUID } from "crypto";
import { z } from "zod";
import { query, queryOne, isUndefinedColumn, withRetry } from "@/lib/dsql";
import { recordAudit } from "@/lib/audit";
import { emitEvent } from "@/lib/events/bus";
import { enqueueNotification } from "@/lib/notifications/outbox";
import { appOrigin, issueShareToken } from "@/lib/share-tokens";
import { tableExists } from "@/lib/table-exists";
import { uploadAttachment } from "@/lib/attachments/store";
import { getBranding } from "@/lib/branding";
import { renderPackingSlipPdf } from "@/lib/pdf/billing-documents";
import { fulfillOrder, getOrder, type OrderDTO } from "@/lib/storefront/orders";
import { getStorefront } from "@/lib/storefront/settings";
import { keysetClause, keysetOrder, type Cursor } from "@/lib/public-api/pagination";
import { credsFor, getProvider, resolveShipping } from "./index";
import { renderShippingLabelPdf } from "./labels";
import { loadProductFacts, DEFAULT_UNIT_WEIGHT_GRAMS, type OrderShippingQuote } from "./quote";
import { nextShipmentStatus } from "./rules";
import {
  formatAddressLines, parseJson, safeHttpsUrl, ShippingError, SHIPMENT_STATUS_LABEL,
  type Address, type CarrierRate, type Parcel, type PurchasedLabel, type ShipmentStatus,
} from "./types";

/** Shipments: creation (carrier label or manual), the status state machine with its side effects, void and bulk create. */

export interface ShipmentItem {
  product_id: string | null;
  description: string;
  qty: number;
}

export interface ShipmentRow {
  id: string;
  user_id: string;
  order_id: string | null;
  return_id: string | null;
  status: ShipmentStatus;
  carrier: string | null;
  service: string | null;
  rate_minor: string | number;
  currency: string;
  tracking_number: string | null;
  tracking_url: string | null;
  label_url_or_attachment_id: string | null;
  weight_grams: number | null;
  dimensions: string | null;
  to_address: string | null;
  from_address: string | null;
  items: string | null;
  insured_minor: string | number;
  provider_ref: string | null;
  purchased_at: string | Date | null;
  delivered_at: string | Date | null;
  created_at: string | Date;
  updated_at: string | Date;
}

export interface ShipmentDTO {
  id: string;
  order_id: string | null;
  return_id: string | null;
  status: ShipmentStatus;
  status_label: string;
  carrier: string | null;
  service: string | null;
  rate_minor: number;
  currency: string;
  tracking_number: string | null;
  tracking_url: string | null;
  label_url: string | null;
  label_attachment_id: string | null;
  weight_grams: number | null;
  dimensions: { length_cm?: number; width_cm?: number; height_cm?: number } | null;
  to_address: Address | null;
  from_address: Address | null;
  items: ShipmentItem[];
  insured_minor: number;
  provider: string | null;
  purchased_at: string | null;
  delivered_at: string | null;
  created_at: string;
  updated_at: string;
}

export const SHIPMENT_COLS =
  "id, user_id, order_id, return_id, status, carrier, service, rate_minor, currency, tracking_number, tracking_url, label_url_or_attachment_id, weight_grams, dimensions, to_address, from_address, items, insured_minor, provider_ref, purchased_at, delivered_at, created_at, updated_at";

const iso = (v: string | Date | null | undefined): string | null => (v ? new Date(v).toISOString() : null);
const URL_RE = /^https:\/\//;

export function toShipmentDTO(r: ShipmentRow): ShipmentDTO {
  const ref = r.label_url_or_attachment_id;
  return {
    id: r.id,
    order_id: r.order_id,
    return_id: r.return_id,
    status: r.status,
    status_label: SHIPMENT_STATUS_LABEL[r.status] ?? r.status,
    carrier: r.carrier,
    service: r.service,
    rate_minor: Number(r.rate_minor),
    currency: r.currency,
    tracking_number: r.tracking_number,
    tracking_url: safeHttpsUrl(r.tracking_url),
    label_url: ref && URL_RE.test(ref) ? safeHttpsUrl(ref) : null,
    label_attachment_id: ref && !URL_RE.test(ref) ? ref : null,
    weight_grams: r.weight_grams,
    dimensions: parseJson(r.dimensions, null),
    to_address: parseJson(r.to_address, null),
    from_address: parseJson(r.from_address, null),
    items: parseJson<ShipmentItem[]>(r.items, []),
    insured_minor: Number(r.insured_minor),
    provider: r.provider_ref ? r.provider_ref.split(":")[0] : null,
    purchased_at: iso(r.purchased_at),
    delivered_at: iso(r.delivered_at),
    created_at: iso(r.created_at) ?? "",
    updated_at: iso(r.updated_at) ?? "",
  };
}

/* ── reads ─────────────────────────────────────────────────────────────── */

export interface ListShipmentsOpts {
  status?: ShipmentStatus | null;
  orderId?: string | null;
  returnId?: string | null;
  q?: string | null;
  limit?: number;
  cursor?: Cursor | null;
}

export async function listShipments(dataId: string, opts: ListShipmentsOpts = {}): Promise<ShipmentDTO[]> {
  if (!(await tableExists("shipments"))) return [];
  const params: unknown[] = [dataId];
  let sql = `SELECT ${SHIPMENT_COLS} FROM shipments WHERE user_id = $1`;
  if (opts.status) { params.push(opts.status); sql += ` AND status = $${params.length}`; }
  if (opts.orderId) { params.push(opts.orderId); sql += ` AND order_id = $${params.length}`; }
  if (opts.returnId) { params.push(opts.returnId); sql += ` AND return_id = $${params.length}`; }
  if (opts.q?.trim()) {
    params.push(`%${opts.q.trim().toLowerCase().replace(/[%_\\]/g, "\\$&").slice(0, 100)}%`);
    sql += ` AND (lower(COALESCE(tracking_number,'')) LIKE $${params.length} OR lower(COALESCE(carrier,'')) LIKE $${params.length})`;
  }
  sql += keysetClause(opts.cursor, params);
  params.push(Math.min(Math.max(opts.limit ?? 50, 1), 500));
  sql += ` ORDER BY ${keysetOrder()} LIMIT $${params.length}`;
  return (await query<ShipmentRow>(sql, params)).map(toShipmentDTO);
}

export async function getShipment(dataId: string, id: string): Promise<ShipmentDTO | null> {
  const r = await queryOne<ShipmentRow>(`SELECT ${SHIPMENT_COLS} FROM shipments WHERE id = $1 AND user_id = $2`, [id, dataId]);
  return r ? toShipmentDTO(r) : null;
}

export interface ShipmentEventDTO {
  id: string;
  status: ShipmentStatus;
  description: string | null;
  location: string | null;
  occurred_at: string;
}

export async function listShipmentEvents(dataId: string, shipmentId: string): Promise<ShipmentEventDTO[]> {
  const rows = await query<{ id: string; status: ShipmentStatus; description: string | null; location: string | null; occurred_at: string | Date }>(
    `SELECT id, status, description, location, occurred_at FROM shipment_events WHERE user_id = $1 AND shipment_id = $2 ORDER BY occurred_at ASC, id ASC LIMIT 500`,
    [dataId, shipmentId]
  );
  return rows.map((r) => ({ ...r, occurred_at: new Date(r.occurred_at).toISOString() }));
}

/* ── order helpers ─────────────────────────────────────────────────────── */

export async function getOrderShipping(dataId: string, orderId: string): Promise<{ method: string | null; quote: OrderShippingQuote | null }> {
  try {
    const r = await queryOne<{ shipping_method: string | null; shipping_quote: string | null }>(`SELECT shipping_method, shipping_quote FROM orders WHERE id = $1 AND user_id = $2`, [orderId, dataId]);
    return { method: r?.shipping_method ?? null, quote: parseJson<OrderShippingQuote | null>(r?.shipping_quote, null) };
  } catch (err) {
    if (isUndefinedColumn(err)) return { method: null, quote: null };
    throw err;
  }
}

export async function setOrderShipping(dataId: string, orderId: string, method: string, quote: OrderShippingQuote): Promise<void> {
  await query(`UPDATE orders SET shipping_method = $3, shipping_quote = $4 WHERE id = $1 AND user_id = $2`, [orderId, dataId, method, JSON.stringify(quote)]);
}

export function orderToAddress(o: OrderDTO): Address | null {
  const a = o.shipping_address;
  if (!a) return null;
  return { name: o.customer_name, line1: a.line1, line2: a.line2, city: a.city, region: a.region, postal_code: a.postal_code, country: a.country, phone: o.customer_phone ?? undefined, email: o.customer_email };
}

async function brandName(dataId: string): Promise<string> {
  const sf = await getStorefront(dataId);
  if (sf.title) return sf.title;
  const b = await getBranding(dataId).catch(() => null);
  return b?.brand_name ?? "Our shop";
}

/** Link the customer opens: /track/<token> (recipient-bound to the order email). */
export async function issueTrackingLink(dataId: string, shipmentId: string, email: string, ttlDays = 90): Promise<{ token: string; path: string; url: string }> {
  const t = await issueShareToken(dataId, "shipment", shipmentId, ttlDays, { recipient: email });
  return { token: t.token, path: t.path, url: `${appOrigin()}${t.path}` };
}

/* ── persistence ───────────────────────────────────────────────────────── */

interface InsertShipment {
  order_id: string | null;
  return_id: string | null;
  status: ShipmentStatus;
  carrier: string | null;
  service: string | null;
  rate_minor: number;
  currency: string;
  tracking_number: string | null;
  tracking_url: string | null;
  label_ref: string | null;
  weight_grams: number | null;
  dimensions: Parcel | null;
  to: Address | null;
  from: Address | null;
  items: ShipmentItem[];
  insured_minor: number;
  provider_ref: string | null;
  purchased: boolean;
}

async function insertShipment(dataId: string, s: InsertShipment): Promise<string> {
  const id = randomUUID();
  const dims = s.dimensions ? { length_cm: s.dimensions.length_cm, width_cm: s.dimensions.width_cm, height_cm: s.dimensions.height_cm } : null;
  try {
    await query(
      `INSERT INTO shipments (id, user_id, order_id, return_id, status, carrier, service, rate_minor, currency, tracking_number, tracking_url, label_url_or_attachment_id, weight_grams, dimensions,
         to_address, from_address, items, insured_minor, provider_ref, purchased_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19, ${s.purchased ? "NOW()" : "NULL"})`,
      [id, dataId, s.order_id, s.return_id, s.status, s.carrier, s.service, s.rate_minor, s.currency, s.tracking_number, safeHttpsUrl(s.tracking_url), s.label_ref, s.weight_grams,
        dims ? JSON.stringify(dims) : null, s.to ? JSON.stringify(s.to) : null, s.from ? JSON.stringify(s.from) : null, JSON.stringify(s.items), s.insured_minor, s.provider_ref]
    );
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && (err as { code?: string }).code === "23505") throw new ShippingError("conflict", "A shipment with this tracking number already exists", 409);
    throw err;
  }
  return id;
}

export async function addShipmentEvent(dataId: string, shipmentId: string, ev: { status: ShipmentStatus; description?: string | null; location?: string | null; occurred_at: string; raw_hash?: string | null }): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `INSERT INTO shipment_events (id, user_id, shipment_id, status, description, location, occurred_at, raw_hash) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (shipment_id, occurred_at, status) DO NOTHING RETURNING id`,
    [randomUUID(), dataId, shipmentId, ev.status, ev.description?.slice(0, 300) ?? null, ev.location?.slice(0, 200) ?? null, ev.occurred_at, ev.raw_hash ?? null]
  );
  return rows.length > 0;
}

/** Stored label PDF (attachment kind "shipment") for shipments whose carrier gave no hosted label. */
async function storeLabelPdf(dataId: string, shipmentId: string, bytes: Uint8Array, name: string, actorId: string | null): Promise<string> {
  const att = await uploadAttachment(dataId, { entityKind: "shipment", entityId: shipmentId, fileName: name, declaredType: "application/pdf", bytes: Buffer.from(bytes), uploadedBy: actorId });
  return att.id;
}

/* ── create ────────────────────────────────────────────────────────────── */

export const PackageInputSchema = z
  .object({
    weight_grams: z.number().int().min(1).max(70_000_000).optional(),
    length_cm: z.number().min(0).max(1000).optional(),
    width_cm: z.number().min(0).max(1000).optional(),
    height_cm: z.number().min(0).max(1000).optional(),
    items: z.array(z.object({ product_id: z.string().max(100).nullable().optional(), description: z.string().max(300), qty: z.number().int().min(1).max(100_000) }).strict()).max(100).optional(),
  })
  .strict();
export type PackageInput = z.infer<typeof PackageInputSchema>;

export const CreateShipmentSchema = z
  .object({
    rate_id: z.string().max(300).optional(),
    provider: z.enum(["simulated", "easypost", "shippo"]).optional(),
    packages: z.array(PackageInputSchema).max(10).optional(),
    /** Manual shipment: no label is bought; staff enter the tracking details. */
    manual: z.object({ carrier: z.string().trim().min(1).max(80), service: z.string().trim().max(80).optional(), tracking_number: z.string().trim().max(120).optional(), tracking_url: z.string().trim().max(2048).optional() }).strict().optional(),
    insured_minor: z.number().int().min(0).max(100_000_000).optional(),
    additional: z.boolean().optional(),
  })
  .strict();
export type CreateShipmentInput = z.infer<typeof CreateShipmentSchema>;

/** Public carrier tracking page templates for manual shipments. */
export function defaultTrackingUrl(carrier: string, tracking: string): string | null {
  const t = encodeURIComponent(tracking);
  const c = carrier.toLowerCase();
  if (c.includes("usps")) return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${t}`;
  if (c.includes("ups")) return `https://www.ups.com/track?tracknum=${t}`;
  if (c.includes("fedex")) return `https://www.fedex.com/fedextrack/?trknbr=${t}`;
  if (c.includes("dhl")) return `https://www.dhl.com/global-en/home/tracking.html?tracking-id=${t}`;
  return null;
}

function orderItemsForShipment(o: OrderDTO): ShipmentItem[] {
  return o.items.map((i) => ({ product_id: i.product_id ?? null, description: i.description, qty: Math.max(1, Math.ceil(Number(i.qty) || 1)) }));
}

async function itemsWeight(dataId: string, items: ShipmentItem[]): Promise<number> {
  const facts = await loadProductFacts(dataId, items.flatMap((i) => (i.product_id ? [i.product_id] : [])));
  return Math.max(1, items.reduce((s, i) => s + (i.product_id ? (facts.get(i.product_id)?.weight ?? DEFAULT_UNIT_WEIGHT_GRAMS) : DEFAULT_UNIT_WEIGHT_GRAMS) * i.qty, 0));
}

/** Rates for a prospective shipment (the staff rate picker). */
export async function ratesForOrder(dataId: string, orderId: string, input: { provider?: string; package?: PackageInput } = {}): Promise<{ rates: CarrierRate[]; provider: string; weight_grams: number; parcel: Parcel }> {
  const order = await getOrder(dataId, orderId);
  if (!order) throw new ShippingError("not_found", "Order not found", 404);
  const to = orderToAddress(order);
  if (!to) throw new ShippingError("invalid", "This order is a collection order and has no shipping address");
  const setup = await resolveShipping(dataId, input.provider);
  const items = orderItemsForShipment(order);
  const weight = input.package?.weight_grams ?? (await itemsWeight(dataId, items));
  const parcel: Parcel = { ...(setup.default_package ?? {}), ...(input.package ? { length_cm: input.package.length_cm, width_cm: input.package.width_cm, height_cm: input.package.height_cm } : {}), weight_grams: weight };
  const from = setup.ship_from ?? (setup.provider.id === "simulated" ? { line1: "Warehouse", city: "Origin", country: to.country } : null);
  if (!from) throw new ShippingError("invalid", "Set a ship-from address under Shipping → Carriers first");
  const rates = await setup.provider.rates({ from, to, parcel, currency: order.currency }, setup.creds);
  return { rates, provider: setup.provider.id, weight_grams: weight, parcel };
}

function pickRate(rates: CarrierRate[], quote: OrderShippingQuote | null, wanted?: string): CarrierRate {
  if (rates.length === 0) throw new ShippingError("rate_failed", "The carrier returned no rates for this parcel");
  if (wanted) {
    const hit = rates.find((r) => r.id === wanted);
    if (hit) return hit;
  }
  if (quote?.service) {
    const hit = rates.find((r) => r.service.toLowerCase() === quote.service?.toLowerCase());
    if (hit) return hit;
  }
  return [...rates].sort((a, b) => a.amount_minor - b.amount_minor)[0];
}

export interface CreateContext {
  actorId?: string | null;
}

/**
 * Create shipment(s) for a paid order: one per package. With `manual` no money is spent; otherwise the
 * provider buys the label (spend!). Callers gate on the plan feature and the write permission.
 */
export async function createShipmentForOrder(dataId: string, orderId: string, input: CreateShipmentInput = {}, ctx: CreateContext = {}): Promise<ShipmentDTO[]> {
  const order = await getOrder(dataId, orderId);
  if (!order) throw new ShippingError("not_found", "Order not found", 404);
  if (order.status !== "paid" && order.status !== "fulfilled") throw new ShippingError("conflict", `Order is ${order.status_label.toLowerCase()}; only paid orders can be shipped`, 409);
  const to = orderToAddress(order);
  if (!to) throw new ShippingError("invalid", "This order is a collection order and has no shipping address");
  if (!input.additional) {
    const live = await query<{ id: string }>(`SELECT id FROM shipments WHERE user_id = $1 AND order_id = $2 AND status <> 'void' LIMIT 1`, [dataId, orderId]);
    if (live.length > 0) throw new ShippingError("conflict", "This order already has a shipment. Void it first or create an additional shipment.", 409);
  }
  const allItems = orderItemsForShipment(order);
  const packages: PackageInput[] = input.packages && input.packages.length > 0 ? input.packages : [{}];
  const out: ShipmentDTO[] = [];
  const { quote } = await getOrderShipping(dataId, orderId);

  for (let idx = 0; idx < packages.length; idx++) {
    const pkg = packages[idx];
    const items: ShipmentItem[] = (pkg.items ?? (idx === 0 ? allItems : [])).map((i) => ({ product_id: i.product_id ?? null, description: i.description, qty: i.qty }));
    const weight = pkg.weight_grams ?? (items.length > 0 ? await itemsWeight(dataId, items) : DEFAULT_UNIT_WEIGHT_GRAMS);

    if (input.manual) {
      const tracking = input.manual.tracking_number?.trim() || null;
      const url = safeHttpsUrl(input.manual.tracking_url) ?? (tracking ? defaultTrackingUrl(input.manual.carrier, tracking) : null);
      const setup = await resolveShipping(dataId).catch(() => null);
      const id = await insertShipment(dataId, { order_id: orderId, return_id: null, status: "label_purchased", carrier: input.manual.carrier, service: input.manual.service ?? null, rate_minor: 0, currency: order.currency, tracking_number: tracking, tracking_url: url, label_ref: null, weight_grams: weight, dimensions: { weight_grams: weight, length_cm: pkg.length_cm, width_cm: pkg.width_cm, height_cm: pkg.height_cm }, to, from: setup?.ship_from ?? null, items, insured_minor: input.insured_minor ?? 0, provider_ref: "manual:", purchased: true });
      await addShipmentEvent(dataId, id, { status: "label_purchased", description: "Shipment recorded manually", occurred_at: new Date().toISOString() });
      void emitEvent(dataId, { type: "shipment.created", entity: "shipment", entityId: id, data: { order_id: orderId, number: order.number, carrier: input.manual.carrier, tracking_number: tracking, manual: true } });
      void recordAudit({ dataId, userId: ctx.actorId ?? null }, { action: "shipment.created", entity: "shipment", entityId: id, after: { order_id: orderId, manual: true } });
      const s = await getShipment(dataId, id);
      if (s) out.push(s);
      continue;
    }

    const setup = await resolveShipping(dataId, input.provider);
    const from = setup.ship_from ?? (setup.provider.id === "simulated" ? { line1: "Warehouse", city: "Origin", country: to.country } : null);
    if (!from) throw new ShippingError("invalid", "Set a ship-from address under Shipping → Carriers first");
    const parcel: Parcel = { ...(setup.default_package ?? {}), ...(pkg.length_cm ? { length_cm: pkg.length_cm } : {}), ...(pkg.width_cm ? { width_cm: pkg.width_cm } : {}), ...(pkg.height_cm ? { height_cm: pkg.height_cm } : {}), weight_grams: weight };
    const req = { from, to, parcel, currency: order.currency, insured_minor: input.insured_minor };
    const rates = await setup.provider.rates(req, setup.creds);
    const rate = pickRate(rates, quote, input.rate_id);
    const label: PurchasedLabel = await setup.provider.buyLabel(rate.id, req, setup.creds);
    let id: string;
    try {
      id = await insertShipment(dataId, { order_id: orderId, return_id: null, status: "label_purchased", carrier: label.carrier, service: label.service, rate_minor: label.rate_minor, currency: label.currency, tracking_number: label.tracking_number, tracking_url: label.tracking_url, label_ref: label.label_url, weight_grams: weight, dimensions: parcel, to, from, items, insured_minor: input.insured_minor ?? 0, provider_ref: label.provider_ref, purchased: true });
    } catch (err) {
      // The label was bought but not recorded: hand the money back rather than leave an orphan.
      await setup.provider.void({ tracking_number: label.tracking_number, provider_ref: label.provider_ref }, setup.creds).catch(() => undefined);
      throw err;
    }
    if (!label.label_url) {
      const pdf = renderShippingLabelPdf({ carrier: label.carrier, service: label.service, tracking_number: label.tracking_number, from, to, weight_grams: weight, order_number: order.number, simulated: setup.provider.id === "simulated" });
      const attId = await storeLabelPdf(dataId, id, pdf, `label-${label.tracking_number}.pdf`, ctx.actorId ?? null);
      await query(`UPDATE shipments SET label_url_or_attachment_id = $3, updated_at = NOW() WHERE id = $1 AND user_id = $2`, [id, dataId, attId]);
    }
    await addShipmentEvent(dataId, id, { status: "label_purchased", description: "Shipping label created", occurred_at: new Date().toISOString() });
    void emitEvent(dataId, { type: "shipment.created", entity: "shipment", entityId: id, data: { order_id: orderId, number: order.number, carrier: label.carrier, service: label.service, tracking_number: label.tracking_number, rate_minor: label.rate_minor } });
    void recordAudit({ dataId, userId: ctx.actorId ?? null }, { action: "shipment.label_purchased", entity: "shipment", entityId: id, after: { order_id: orderId, rate_minor: label.rate_minor, currency: label.currency, carrier: label.carrier } });
    const s = await getShipment(dataId, id);
    if (s) out.push(s);
  }
  return out;
}

/** Create a shipment for a return (customer → merchant) with a reverse label, or record it manually. */
export async function insertReturnShipment(dataId: string, returnId: string, order: OrderDTO, input: { provider?: string; manual?: { carrier: string; tracking_number?: string; tracking_url?: string }; items: ShipmentItem[]; actorId?: string | null }): Promise<ShipmentDTO> {
  const customer = orderToAddress(order);
  if (!customer) throw new ShippingError("invalid", "The order has no shipping address to return from");
  const setup = await resolveShipping(dataId, input.provider);
  const merchant = setup.ship_from ?? (setup.provider.id === "simulated" ? { line1: "Returns", city: "Origin", country: customer.country } : null);
  if (!merchant) throw new ShippingError("invalid", "Set a ship-from address under Shipping → Carriers first");
  const weight = await itemsWeight(dataId, input.items);
  if (input.manual) {
    const url = safeHttpsUrl(input.manual.tracking_url) ?? (input.manual.tracking_number ? defaultTrackingUrl(input.manual.carrier, input.manual.tracking_number) : null);
    const id = await insertShipment(dataId, { order_id: order.id, return_id: returnId, status: "label_purchased", carrier: input.manual.carrier, service: "return", rate_minor: 0, currency: order.currency, tracking_number: input.manual.tracking_number ?? null, tracking_url: url, label_ref: null, weight_grams: weight, dimensions: null, to: merchant, from: customer, items: input.items, insured_minor: 0, provider_ref: "manual:", purchased: true });
    await addShipmentEvent(dataId, id, { status: "label_purchased", description: "Return shipment recorded", occurred_at: new Date().toISOString() });
    return (await getShipment(dataId, id)) as ShipmentDTO;
  }
  const parcel: Parcel = { ...(setup.default_package ?? {}), weight_grams: weight };
  const req = { from: customer, to: merchant, parcel, currency: order.currency };
  const rate = pickRate(await setup.provider.rates(req, setup.creds), null);
  const label = await setup.provider.buyLabel(rate.id, req, setup.creds);
  const id = await insertShipment(dataId, { order_id: order.id, return_id: returnId, status: "label_purchased", carrier: label.carrier, service: label.service, rate_minor: label.rate_minor, currency: label.currency, tracking_number: label.tracking_number, tracking_url: label.tracking_url, label_ref: label.label_url, weight_grams: weight, dimensions: parcel, to: merchant, from: customer, items: input.items, insured_minor: 0, provider_ref: label.provider_ref, purchased: true });
  if (!label.label_url) {
    const pdf = renderShippingLabelPdf({ carrier: label.carrier, service: `${label.service} (return)`, tracking_number: label.tracking_number, from: customer, to: merchant, weight_grams: weight, order_number: order.number, simulated: setup.provider.id === "simulated", reference: "RETURN" });
    const attId = await storeLabelPdf(dataId, id, pdf, `return-label-${label.tracking_number}.pdf`, input.actorId ?? null);
    await query(`UPDATE shipments SET label_url_or_attachment_id = $3, updated_at = NOW() WHERE id = $1 AND user_id = $2`, [id, dataId, attId]);
  }
  await addShipmentEvent(dataId, id, { status: "label_purchased", description: "Return label created", occurred_at: new Date().toISOString() });
  void emitEvent(dataId, { type: "shipment.created", entity: "shipment", entityId: id, data: { order_id: order.id, return_id: returnId, carrier: label.carrier, tracking_number: label.tracking_number, rate_minor: label.rate_minor } });
  return (await getShipment(dataId, id)) as ShipmentDTO;
}

/* ── status machine ────────────────────────────────────────────────────── */

type Notice = "shipped" | "out_for_delivery" | "delivered";

const NOTICE_COPY: Record<Notice, (from: string, number: string, url: string, carrierLine: string) => { subject: string; text: string }> = {
  shipped: (from, number, url, c) => ({ subject: `Your order ${number} has shipped — ${from}`, text: `Good news: your order is on its way${c}.\n\nTrack your package: ${url}` }),
  out_for_delivery: (from, number, url) => ({ subject: `Order ${number} is out for delivery — ${from}`, text: `Your package is out for delivery today.\n\nTrack your package: ${url}` }),
  delivered: (from, number, url) => ({ subject: `Order ${number} was delivered — ${from}`, text: `Your package has been delivered.\n\nDelivery details: ${url}\n\nIf something is not right, you can start a return from your order page.` }),
};

async function notifyCustomer(dataId: string, s: ShipmentDTO, order: OrderDTO, kind: Notice): Promise<void> {
  try {
    const from = await brandName(dataId);
    const link = await issueTrackingLink(dataId, s.id, order.customer_email);
    const carrierLine = s.carrier ? ` with ${s.carrier}${s.tracking_number ? ` (tracking ${s.tracking_number})` : ""}` : "";
    const c = NOTICE_COPY[kind](from, order.number, link.url, carrierLine);
    await enqueueNotification(dataId, {
      channel: "email",
      recipient: order.customer_email,
      subject: c.subject,
      body: `Hi ${order.customer_name},\n\n${c.text}\n\n${from}`,
      data: { kind: `shipment_${kind}`, category: "orders", shipment_id: s.id, order_id: order.id, number: order.number, url: link.url },
    });
  } catch (err) {
    console.error(`[shipping] ${kind} email failed for ${s.id}:`, err);
  }
}

export interface StatusChange {
  changed: boolean;
  from: ShipmentStatus;
  to: ShipmentStatus;
}

/**
 * Move a shipment to the status a carrier (or staff) reports. Forward-only
 * (see nextShipmentStatus); the conditional UPDATE guarantees side effects run
 * once per transition even with concurrent webhooks and polls.
 */
export async function applyShipmentStatus(dataId: string, shipmentId: string, incoming: ShipmentStatus, actorId?: string | null): Promise<StatusChange> {
  const cur = await getShipment(dataId, shipmentId);
  if (!cur) throw new ShippingError("not_found", "Shipment not found", 404);
  const next = nextShipmentStatus(cur.status, incoming);
  if (next === cur.status) return { changed: false, from: cur.status, to: cur.status };
  const rows = await withRetry(() =>
    query<{ id: string }>(
      `UPDATE shipments SET status = $4, updated_at = NOW(), delivered_at = CASE WHEN $4 = 'delivered' THEN NOW() ELSE delivered_at END WHERE id = $1 AND user_id = $2 AND status = $3 RETURNING id`,
      [shipmentId, dataId, cur.status, next]
    )
  );
  if (rows.length === 0) return { changed: false, from: cur.status, to: cur.status };
  const s = (await getShipment(dataId, shipmentId)) ?? cur;
  const order = s.order_id && !s.return_id ? await getOrder(dataId, s.order_id) : null;
  const firstShip = (cur.status === "label_purchased" || cur.status === "draft") && next === "in_transit";
  if (firstShip) {
    void emitEvent(dataId, { type: "shipment.shipped", entity: "shipment", entityId: s.id, data: { order_id: s.order_id, carrier: s.carrier, tracking_number: s.tracking_number, number: order?.number ?? null, customer_email: order?.customer_email ?? null, actor: actorId ?? null } });
    if (order) {
      if (order.status === "paid") await fulfillOrder(dataId, order.id, actorId ?? null, { notify: false }).catch((e) => console.error("[shipping] fulfil on ship failed:", e));
      await notifyCustomer(dataId, s, order, "shipped");
    }
  } else if (next === "out_for_delivery" && order) {
    await notifyCustomer(dataId, s, order, "out_for_delivery");
  } else if (next === "exception") {
    void emitEvent(dataId, { type: "shipment.exception", entity: "shipment", entityId: s.id, data: { order_id: s.order_id, carrier: s.carrier, tracking_number: s.tracking_number, number: order?.number ?? null } });
  } else if (next === "delivered") {
    void emitEvent(dataId, { type: "shipment.delivered", entity: "shipment", entityId: s.id, data: { order_id: s.order_id, return_id: s.return_id, carrier: s.carrier, tracking_number: s.tracking_number, number: order?.number ?? null, customer_email: order?.customer_email ?? null } });
    if (order) {
      let o = order;
      if (o.status === "paid") o = await fulfillOrder(dataId, o.id, actorId ?? null, { notify: false }).catch(() => o);
      void emitEvent(dataId, { type: "order.delivered", entity: "order", entityId: o.id, data: { number: o.number, customer_email: o.customer_email, contact_id: o.contact_id, shipment_id: s.id } });
      await notifyCustomer(dataId, s, o, "delivered");
    }
  }
  return { changed: true, from: cur.status, to: next };
}

/** Staff: the package left (manual shipments, or a label that was handed to the carrier). */
export async function markShipped(dataId: string, shipmentId: string, patch: { carrier?: string; tracking_number?: string; tracking_url?: string } = {}, actorId?: string | null): Promise<ShipmentDTO> {
  const cur = await getShipment(dataId, shipmentId);
  if (!cur) throw new ShippingError("not_found", "Shipment not found", 404);
  if (cur.status === "void") throw new ShippingError("conflict", "Shipment is void", 409);
  if (patch.tracking_number || patch.tracking_url || patch.carrier) {
    const carrier = patch.carrier ?? cur.carrier;
    const tracking = patch.tracking_number ?? cur.tracking_number;
    const url = safeHttpsUrl(patch.tracking_url) ?? cur.tracking_url ?? (carrier && tracking ? defaultTrackingUrl(carrier, tracking) : null);
    try {
      await query(`UPDATE shipments SET carrier = $3, tracking_number = $4, tracking_url = $5, updated_at = NOW() WHERE id = $1 AND user_id = $2`, [shipmentId, dataId, carrier, tracking, url]);
    } catch (err) {
      if (err && typeof err === "object" && (err as { code?: string }).code === "23505") throw new ShippingError("conflict", "A shipment with this tracking number already exists", 409);
      throw err;
    }
  }
  await addShipmentEvent(dataId, shipmentId, { status: "in_transit", description: "Handed to carrier", occurred_at: new Date().toISOString() });
  await applyShipmentStatus(dataId, shipmentId, "in_transit", actorId);
  return (await getShipment(dataId, shipmentId)) as ShipmentDTO;
}

/** Void an unused label: asks the provider for a refund, then closes the shipment. Only before the carrier scanned it. */
export async function voidShipment(dataId: string, shipmentId: string, actorId?: string | null): Promise<ShipmentDTO> {
  const cur = await getShipment(dataId, shipmentId);
  if (!cur) throw new ShippingError("not_found", "Shipment not found", 404);
  if (cur.status === "void") return cur;
  if (cur.status !== "label_purchased" && cur.status !== "draft") throw new ShippingError("conflict", `A shipment that is ${cur.status_label.toLowerCase()} cannot be voided`, 409);
  const row = await queryOne<{ provider_ref: string | null }>(`SELECT provider_ref FROM shipments WHERE id = $1 AND user_id = $2`, [shipmentId, dataId]);
  const providerId = row?.provider_ref?.split(":")[0] ?? "";
  const provider = getProvider(providerId);
  if (provider && cur.tracking_number) {
    const creds = providerId === "simulated" ? null : await credsFor(dataId, providerId);
    await provider.void({ tracking_number: cur.tracking_number, provider_ref: row?.provider_ref ?? null }, creds);
  }
  await query(`UPDATE shipments SET status = 'void', updated_at = NOW() WHERE id = $1 AND user_id = $2`, [shipmentId, dataId]);
  await addShipmentEvent(dataId, shipmentId, { status: "void", description: "Label voided", occurred_at: new Date().toISOString() });
  void recordAudit({ dataId, userId: actorId ?? null }, { action: "shipment.voided", entity: "shipment", entityId: shipmentId, after: { tracking_number: cur.tracking_number } });
  return (await getShipment(dataId, shipmentId)) as ShipmentDTO;
}

/* ── bulk ──────────────────────────────────────────────────────────────── */

export const BULK_LIMIT = 50;

export interface BulkResult {
  order_id: string;
  ok: boolean;
  shipment_ids: string[];
  error?: string;
}

/** Create shipments for many paid orders (≤ 50): quoted carrier service where available, else cheapest. Failures are reported per order. */
export async function bulkCreateShipments(dataId: string, orderIds: string[], input: { provider?: "simulated" | "easypost" | "shippo" } = {}, ctx: CreateContext = {}): Promise<BulkResult[]> {
  const ids = [...new Set(orderIds)].slice(0, BULK_LIMIT);
  const out: BulkResult[] = [];
  for (const id of ids) {
    try {
      const made = await createShipmentForOrder(dataId, id, { provider: input.provider }, ctx);
      out.push({ order_id: id, ok: true, shipment_ids: made.map((m) => m.id) });
    } catch (err) {
      out.push({ order_id: id, ok: false, shipment_ids: [], error: err instanceof Error ? err.message : "failed" });
    }
  }
  return out;
}

/* ── documents ─────────────────────────────────────────────────────────── */

export async function renderPackingSlipFor(dataId: string, shipmentId: string): Promise<{ bytes: Uint8Array; fileName: string }> {
  const s = await getShipment(dataId, shipmentId);
  if (!s) throw new ShippingError("not_found", "Shipment not found", 404);
  const order = s.order_id ? await getOrder(dataId, s.order_id) : null;
  const branding = await getBranding(dataId).catch(() => null);
  const number = order?.number ?? s.id.slice(0, 8);
  const bytes = renderPackingSlipPdf(
    { order_number: number, created_at: order?.created_at ?? s.created_at, customer_name: order?.customer_name ?? s.to_address?.name ?? "", ship_to: formatAddressLines(s.to_address).slice(1), carrier: s.carrier, service: s.service, tracking_number: s.tracking_number, items: s.items.map((i) => ({ description: i.description, qty: i.qty })), notes: order?.notes ?? null },
    { brand_name: branding?.brand_name ?? null, primary_color: branding?.primary_color ?? null, support_email: branding?.support_email ?? null } as Parameters<typeof renderPackingSlipPdf>[1]
  );
  return { bytes, fileName: `packing-slip-${number}.pdf` };
}

export async function shipmentsForOrder(dataId: string, orderId: string): Promise<ShipmentDTO[]> {
  return listShipments(dataId, { orderId, limit: 50 });
}
