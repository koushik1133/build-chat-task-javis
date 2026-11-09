/**
 * Shipping types (client-safe: no DB, no server imports).
 */
import { z } from "zod";

export const AddressSchema = z
  .object({
    name: z.string().trim().max(200).optional(),
    company: z.string().trim().max(200).optional(),
    line1: z.string().trim().min(1).max(200),
    line2: z.string().trim().max(200).optional(),
    city: z.string().trim().min(1).max(100),
    region: z.string().trim().max(100).optional(),
    postal_code: z.string().trim().max(32).optional(),
    country: z.string().trim().min(2).max(64),
    phone: z.string().trim().max(40).optional(),
    email: z.string().trim().max(320).optional(),
  })
  .strict();
export type Address = z.infer<typeof AddressSchema>;

export const PackageSchema = z
  .object({
    weight_grams: z.number().int().min(1).max(70_000_000),
    length_cm: z.number().min(0).max(1000).optional(),
    width_cm: z.number().min(0).max(1000).optional(),
    height_cm: z.number().min(0).max(1000).optional(),
  })
  .strict();
export type Parcel = z.infer<typeof PackageSchema>;

export const SHIPMENT_STATUSES = ["draft", "label_purchased", "in_transit", "out_for_delivery", "delivered", "exception", "returned", "void"] as const;
export type ShipmentStatus = (typeof SHIPMENT_STATUSES)[number];
export const SHIPMENT_STATUS_LABEL: Record<ShipmentStatus, string> = {
  draft: "Draft",
  label_purchased: "Label purchased",
  in_transit: "In transit",
  out_for_delivery: "Out for delivery",
  delivered: "Delivered",
  exception: "Exception",
  returned: "Returned",
  void: "Void",
};
/** Statuses a carrier can report. */
export type TrackStatus = Exclude<ShipmentStatus, "draft" | "void">;

export const RETURN_STATUSES = ["requested", "approved", "rejected", "label_sent", "received", "refunded", "closed"] as const;
export type ReturnStatus = (typeof RETURN_STATUSES)[number];
export const RETURN_RESOLUTIONS = ["refund", "exchange", "store_credit"] as const;
export type ReturnResolution = (typeof RETURN_RESOLUTIONS)[number];

export interface RateRequest {
  from: Address;
  to: Address;
  parcel: Parcel;
  currency: string;
  insured_minor?: number;
}

export interface CarrierRate {
  /** Opaque, provider-specific; passed back to buyLabel. */
  id: string;
  provider: string;
  carrier: string;
  service: string;
  service_label: string;
  amount_minor: number;
  currency: string;
  days_min: number | null;
  days_max: number | null;
}

export interface PurchasedLabel {
  tracking_number: string;
  tracking_url: string | null;
  carrier: string;
  service: string;
  rate_minor: number;
  currency: string;
  provider_ref: string;
  /** Hosted label (https) from the carrier, or null when we render our own PDF. */
  label_url: string | null;
}

export interface TrackingEventInput {
  status: TrackStatus;
  description: string;
  location: string | null;
  occurred_at: string;
}

export interface ProviderCreds {
  api_key: string | null;
}

export interface TrackingRef {
  tracking_number: string;
  carrier: string | null;
  service: string | null;
  purchased_at: string | null;
  provider_ref: string | null;
  now?: Date;
}

export interface ParsedWebhook {
  tracking_number: string;
  carrier: string | null;
  event: TrackingEventInput;
}

export interface ShippingProvider {
  id: "simulated" | "easypost" | "shippo";
  label: string;
  /** True when usable right now (platform env key or a stored credential). */
  configured(creds?: ProviderCreds | null): boolean;
  unavailableReason(): string;
  rates(req: RateRequest, creds: ProviderCreds | null): Promise<CarrierRate[]>;
  buyLabel(rateId: string, req: RateRequest, creds: ProviderCreds | null): Promise<PurchasedLabel>;
  track(ref: TrackingRef, creds: ProviderCreds | null): Promise<TrackingEventInput[]>;
  void(label: { tracking_number: string; provider_ref: string | null }, creds: ProviderCreds | null): Promise<void>;
  /** Verify and parse a webhook delivery. Returns null when the signature is invalid. */
  verifyWebhook(rawBody: string, headers: { get(name: string): string | null }, url?: URL): ParsedWebhook[] | null;
}

export class ShippingError extends Error {
  constructor(
    public readonly code: "unavailable" | "rate_failed" | "label_failed" | "invalid" | "not_found" | "conflict" | "plan" | "return_window",
    message: string,
    public readonly status = 400
  ) {
    super(message);
    this.name = "ShippingError";
  }
}

/** Only https URLs without credentials; used for tracking and label links before they are stored or rendered. */
export function safeHttpsUrl(raw: string | null | undefined): string | null {
  if (!raw || raw.length > 2048) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.username || u.password) return null;
  const host = u.hostname.toLowerCase();
  if (!host.includes(".") || /^[\d.]+$/.test(host) || host.includes(":") || host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".localhost") || host === "localhost") return null;
  return u.toString();
}

export function formatAddressLines(a: Address | null | undefined): string[] {
  if (!a) return [];
  return [a.name, a.company, a.line1, a.line2, [a.city, a.region, a.postal_code].filter(Boolean).join(" "), a.country].filter((s): s is string => Boolean(s && s.trim()));
}

export function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
