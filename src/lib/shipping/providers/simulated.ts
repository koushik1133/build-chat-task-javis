import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "crypto";
import { ShippingError, type CarrierRate, type ParsedWebhook, type PurchasedLabel, type RateRequest, type ShippingProvider, type TrackingEventInput, type TrackingRef, type TrackStatus } from "../types";

/**
 * Simulated carrier. Deterministic rate table by weight and zone, fake
 * tracking numbers and a scripted tracking timeline driven by elapsed time.
 * Labels from this provider are never valid postage (the PDF says so).
 */

export const SIM_SERVICES = {
  standard: { label: "Standard", base: 599, per_kg: 120, days_min: 3, days_max: 5 },
  express: { label: "Express", base: 1299, per_kg: 250, days_min: 1, days_max: 2 },
  economy: { label: "Economy", base: 399, per_kg: 80, days_min: 5, days_max: 8 },
} as const;
export type SimService = keyof typeof SIM_SERVICES;

/** 1 = same country, 3 = international. */
export function simZone(fromCountry: string, toCountry: string): 1 | 3 {
  return fromCountry.trim().toLowerCase() === toCountry.trim().toLowerCase() ? 1 : 3;
}

export function simRateMinor(service: SimService, weightGrams: number, zone: 1 | 3): number {
  const s = SIM_SERVICES[service];
  const kg = Math.max(1, Math.ceil(weightGrams / 1000));
  return Math.round((s.base + s.per_kg * kg) * (zone === 3 ? 2.2 : 1));
}

function isService(v: string): v is SimService {
  return v in SIM_SERVICES;
}

/** Scripted events relative to purchase: label, pickup, hub scan, out for delivery, delivered. */
export function simScript(service: SimService): Array<{ offset_ms: number; status: TrackStatus; description: string; location: string | null }> {
  const s = SIM_SERVICES[service];
  const day = 86_400_000;
  return [
    { offset_ms: 0, status: "label_purchased", description: "Shipping label created", location: null },
    { offset_ms: Math.round(0.15 * day), status: "in_transit", description: "Picked up by carrier", location: "Origin facility" },
    { offset_ms: Math.round(0.5 * day * s.days_min), status: "in_transit", description: "Arrived at sorting hub", location: "Regional hub" },
    { offset_ms: Math.round(day * Math.max(0.6, s.days_max - 0.4)), status: "out_for_delivery", description: "Out for delivery", location: "Local depot" },
    { offset_ms: Math.round(day * s.days_max), status: "delivered", description: "Delivered", location: null },
  ];
}

export function simulatedEvents(ref: TrackingRef): TrackingEventInput[] {
  const service: SimService = ref.service && isService(ref.service) ? ref.service : "standard";
  const start = ref.purchased_at ? new Date(ref.purchased_at).getTime() : NaN;
  if (!Number.isFinite(start)) return [];
  const now = (ref.now ?? new Date()).getTime();
  return simScript(service)
    .filter((e) => start + e.offset_ms <= now)
    .map((e) => ({ status: e.status, description: e.description, location: e.location, occurred_at: new Date(start + e.offset_ms).toISOString() }));
}

function signature(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

export function safeEqualHex(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}

const STATUSES: readonly TrackStatus[] = ["label_purchased", "in_transit", "out_for_delivery", "delivered", "exception", "returned"];

export const simulatedProvider: ShippingProvider = {
  id: "simulated",
  label: "Simulated carrier",
  configured: () => true,
  unavailableReason: () => "",
  async rates(req: RateRequest): Promise<CarrierRate[]> {
    const zone = simZone(req.from.country, req.to.country);
    return (Object.keys(SIM_SERVICES) as SimService[]).map((svc) => {
      const amount = simRateMinor(svc, req.parcel.weight_grams, zone);
      return {
        id: `sim:${svc}:${amount}:${zone}`,
        provider: "simulated",
        carrier: "SimCarrier",
        service: svc,
        service_label: SIM_SERVICES[svc].label,
        amount_minor: amount,
        currency: req.currency,
        days_min: SIM_SERVICES[svc].days_min,
        days_max: SIM_SERVICES[svc].days_max,
      };
    });
  },
  async buyLabel(rateId: string, req: RateRequest): Promise<PurchasedLabel> {
    const [prefix, svc, amount] = rateId.split(":");
    if (prefix !== "sim" || !svc || !isService(svc)) throw new ShippingError("invalid", "Unknown simulated rate");
    const tracking = `KH${BigInt("0x" + randomBytes(6).toString("hex")).toString().padStart(14, "0").slice(0, 12)}`;
    return {
      tracking_number: tracking,
      tracking_url: null,
      carrier: "SimCarrier",
      service: svc,
      rate_minor: Number(amount) || simRateMinor(svc, req.parcel.weight_grams, simZone(req.from.country, req.to.country)),
      currency: req.currency,
      provider_ref: `simulated:${randomUUID()}`,
      label_url: null,
    };
  },
  async track(ref) {
    return simulatedEvents(ref);
  },
  async void() {
    /* nothing to refund */
  },
  verifyWebhook(rawBody, headers) {
    const secret = process.env.SHIPPING_WEBHOOK_SECRET;
    const sig = headers.get("x-kernelhub-signature");
    if (!secret || !sig || !safeEqualHex(sig, signature(secret, rawBody))) return null;
    try {
      const j = JSON.parse(rawBody) as Record<string, unknown>;
      const status = String(j.status);
      if (typeof j.tracking_number !== "string" || !(STATUSES as readonly string[]).includes(status)) return [];
      const at = typeof j.occurred_at === "string" && Number.isFinite(Date.parse(j.occurred_at)) ? new Date(j.occurred_at).toISOString() : new Date().toISOString();
      const out: ParsedWebhook = {
        tracking_number: j.tracking_number,
        carrier: typeof j.carrier === "string" ? j.carrier : "SimCarrier",
        event: { status: status as TrackStatus, description: typeof j.description === "string" ? j.description.slice(0, 300) : status, location: typeof j.location === "string" ? j.location.slice(0, 200) : null, occurred_at: at },
      };
      return [out];
    } catch {
      return [];
    }
  },
};

export { signature as simulatedSignature };
