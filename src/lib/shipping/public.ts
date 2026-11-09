import { resolveShareToken } from "@/lib/share-tokens";
import { getBranding, type Branding } from "@/lib/branding";
import { getOrder } from "@/lib/storefront/orders";
import { getStorefront } from "@/lib/storefront/settings";
import { getShipment, listShipmentEvents, listShipments, type ShipmentDTO } from "./shipments";
import type { ShipmentStatus } from "./types";

/** Public tracking: resolves /track/<token> (a shipment token, or an order token to see every parcel of the order). */

export interface PublicShipment {
  id: string;
  carrier: string | null;
  service: string | null;
  tracking_number: string | null;
  tracking_url: string | null;
  status: ShipmentStatus;
  status_label: string;
  delivered_at: string | null;
  is_return: boolean;
  can_download_label: boolean;
  destination: string | null;
  items: Array<{ description: string; qty: number }>;
  events: Array<{ status: ShipmentStatus; description: string | null; location: string | null; occurred_at: string }>;
}

export interface PublicTracking {
  shop_name: string;
  branding: Pick<Branding, "primary_color" | "logo_url" | "support_email">;
  order_number: string | null;
  recipient: string | null;
  kind: "shipment" | "order";
  shipments: PublicShipment[];
}

async function toPublic(dataId: string, s: ShipmentDTO): Promise<PublicShipment> {
  const events = await listShipmentEvents(dataId, s.id);
  return {
    id: s.id,
    carrier: s.carrier,
    service: s.service,
    tracking_number: s.tracking_number,
    tracking_url: s.tracking_url,
    status: s.status,
    status_label: s.status_label,
    delivered_at: s.delivered_at,
    is_return: Boolean(s.return_id),
    can_download_label: Boolean(s.return_id && (s.label_attachment_id || s.label_url) && s.status === "label_purchased"),
    destination: s.return_id ? null : [s.to_address?.city, s.to_address?.country].filter(Boolean).join(", ") || null,
    items: s.items.map((i) => ({ description: i.description, qty: i.qty })),
    events: events.filter((e) => e.status !== "void").map((e) => ({ status: e.status, description: e.description, location: e.location, occurred_at: e.occurred_at })),
  };
}

/** Null for unknown, expired or revoked tokens (indistinguishable on purpose). */
export async function resolveTracking(token: string): Promise<PublicTracking | null> {
  const ship = await resolveShareToken("shipment", token);
  let dataId: string;
  let shipments: ShipmentDTO[];
  let orderId: string | null;
  let recipient: string | null;
  let kind: "shipment" | "order";
  if (ship) {
    dataId = ship.user_id;
    const s = await getShipment(dataId, ship.entity_id);
    if (!s) return null;
    shipments = [s];
    orderId = s.order_id;
    recipient = ship.recipient;
    kind = "shipment";
  } else {
    const ord = await resolveShareToken("order", token);
    if (!ord) return null;
    dataId = ord.user_id;
    orderId = ord.entity_id;
    recipient = ord.recipient;
    shipments = (await listShipments(dataId, { orderId, limit: 20 })).filter((s) => !s.return_id && s.status !== "void");
    kind = "order";
  }
  const [order, sf, branding] = await Promise.all([orderId ? getOrder(dataId, orderId) : null, getStorefront(dataId), getBranding(dataId)]);
  return {
    shop_name: sf.title ?? branding.brand_name,
    branding: { primary_color: branding.primary_color, logo_url: branding.logo_url, support_email: branding.support_email },
    order_number: order?.number ?? null,
    recipient,
    kind,
    shipments: await Promise.all(shipments.map((s) => toPublic(dataId, s))),
  };
}
