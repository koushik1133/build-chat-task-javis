import type { Tone } from "@/components/ui/pill";

export interface LocationItem {
  id: string;
  name: string;
  code: string | null;
  kind: "store" | "warehouse" | "van" | "virtual";
  address: { line1?: string | null; line2?: string | null; city?: string | null; region?: string | null; postal_code?: string | null; country?: string | null } | null;
  active: boolean;
  is_default: boolean;
}

export interface ProductLite {
  id: string;
  name: string;
  sku: string | null;
  track_stock: boolean;
}

export interface LevelItem {
  product_id: string;
  location_id: string;
  location_name: string;
  on_hand: number;
  reserved: number;
  available: number;
  low: boolean;
}

export type TransferStatus = "draft" | "in_transit" | "received" | "cancelled";
export interface TransferItem {
  id: string;
  number: string;
  status: TransferStatus;
  from_location_id: string;
  to_location_id: string;
  from_name: string | null;
  to_name: string | null;
  note: string | null;
  created_at: string;
  shipped_at: string | null;
  received_at: string | null;
  lines: Array<{ id: string; product_id: string; product_name: string | null; product_sku: string | null; qty: number; received_qty: number; remaining: number }>;
}

export interface CountLine {
  id: string;
  product_id: string;
  product_name: string | null;
  product_sku: string | null;
  expected_qty: number;
  counted_qty: number | null;
  variance: number | null;
}
export interface CountSummaryItem {
  lines: number;
  counted: number;
  with_variance: number;
  net_variance: number;
  shrinkage: number;
  overage: number;
}
export interface CountItem {
  id: string;
  location_id: string;
  location_name: string | null;
  status: "open" | "counted" | "applied";
  created_at: string;
  applied_at: string | null;
  summary: CountSummaryItem;
  lines?: CountLine[];
}

export const TRANSFER_TONE: Record<TransferStatus, Tone> = { draft: "neutral", in_transit: "info", received: "success", cancelled: "danger" };
export const COUNT_TONE: Record<CountItem["status"], Tone> = { open: "neutral", counted: "warning", applied: "success" };
export const KIND_LABEL: Record<LocationItem["kind"], string> = { store: "Store", warehouse: "Warehouse", van: "Van", virtual: "Virtual" };
