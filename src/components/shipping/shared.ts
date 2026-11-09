import type { Tone } from "@/components/ui/pill";
import type { ReturnStatus, ShipmentStatus } from "@/lib/shipping/types";

/** Client-safe shared bits for the shipping UI. */
export const SHIPMENT_TONE: Record<ShipmentStatus, Tone> = { draft: "neutral", label_purchased: "info", in_transit: "info", out_for_delivery: "accent", delivered: "success", exception: "danger", returned: "warning", void: "neutral" };
export const RETURN_TONE: Record<ReturnStatus, Tone> = { requested: "warning", approved: "info", rejected: "neutral", label_sent: "info", received: "accent", refunded: "success", closed: "neutral" };

export interface ShipmentView {
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
  items: Array<{ description: string; qty: number }>;
  created_at: string;
  delivered_at: string | null;
}

export interface ShipmentEventView {
  id: string;
  status: ShipmentStatus;
  description: string | null;
  location: string | null;
  occurred_at: string;
}

export interface ReturnView {
  id: string;
  order_id: string;
  order_number: string | null;
  status: ReturnStatus;
  reason: string | null;
  items: Array<{ product_id?: string | null; description: string; qty: number }>;
  resolution: "refund" | "exchange" | "store_credit";
  notes: string | null;
  refund_minor: number;
  created_at: string;
  suggested_refund_minor?: number;
}

export const fmtWhen = (iso: string): string => new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));
