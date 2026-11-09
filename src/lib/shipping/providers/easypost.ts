import { createHmac } from "crypto";
import { carrierFetch, cmToIn, envKey, gramsToOz, loc, minorFromDecimal } from "./http";
import { safeEqualHex } from "./simulated";
import { safeHttpsUrl, ShippingError, type Address, type CarrierRate, type ParsedWebhook, type ProviderCreds, type PurchasedLabel, type RateRequest, type ShippingProvider, type TrackingEventInput, type TrackStatus } from "../types";

/**
 * EasyPost (https://docs.easypost.com). Implemented against the REST docs; UNTESTED against the live API.
 * Needs EASYPOST_API_KEY (dev fallback) or a per-org key; webhooks verified with EASYPOST_WEBHOOK_SECRET.
 */
const BASE = "https://api.easypost.com/v2";

function auth(creds: ProviderCreds | null): Record<string, string> {
  const key = creds?.api_key || envKey("EASYPOST_API_KEY");
  if (!key) throw new ShippingError("unavailable", "EasyPost is not connected");
  return { Authorization: `Basic ${Buffer.from(`${key}:`).toString("base64")}` };
}

const addr = (a: Address) => ({ name: a.name, company: a.company, street1: a.line1, street2: a.line2, city: a.city, state: a.region, zip: a.postal_code, country: a.country, phone: a.phone, email: a.email });

export function mapEasyPostStatus(s: string | undefined): TrackStatus | null {
  switch ((s ?? "").toLowerCase()) {
    case "pre_transit": return "label_purchased";
    case "in_transit": return "in_transit";
    case "out_for_delivery": case "available_for_pickup": return "out_for_delivery";
    case "delivered": return "delivered";
    case "return_to_sender": return "returned";
    case "failure": case "error": case "cancelled": return "exception";
    default: return null;
  }
}

interface EpDetail { status?: string; message?: string; datetime?: string; tracking_location?: { city?: string; state?: string; country?: string } }
const toEvents = (d: EpDetail[] | undefined): TrackingEventInput[] =>
  (d ?? []).flatMap((x) => {
    const status = mapEasyPostStatus(x.status);
    const t = x.datetime ? Date.parse(x.datetime) : NaN;
    return status && Number.isFinite(t) ? [{ status, description: (x.message ?? status).slice(0, 300), location: loc(x.tracking_location?.city, x.tracking_location?.state, x.tracking_location?.country), occurred_at: new Date(t).toISOString() }] : [];
  });

export const easypostProvider: ShippingProvider = {
  id: "easypost",
  label: "EasyPost",
  configured: (creds) => Boolean(creds?.api_key || envKey("EASYPOST_API_KEY")),
  unavailableReason: () => "Connect an EasyPost API key (Shipping → Carriers) or set EASYPOST_API_KEY in development.",
  async rates(req: RateRequest, creds) {
    const p = req.parcel;
    const res = await carrierFetch<{ id: string; rates?: Array<{ id: string; carrier: string; service: string; rate: string; currency: string; delivery_days?: number | null }> }>(
      `${BASE}/shipments`,
      { method: "POST", headers: auth(creds), body: { shipment: { to_address: addr(req.to), from_address: addr(req.from), parcel: { weight: gramsToOz(p.weight_grams), length: cmToIn(p.length_cm), width: cmToIn(p.width_cm), height: cmToIn(p.height_cm) }, ...(req.insured_minor ? { options: { insurance: (req.insured_minor / 100).toFixed(2) } } : {}) } } },
      "EasyPost rate request"
    );
    return (res.rates ?? []).map<CarrierRate>((r) => ({ id: `${res.id}|${r.id}`, provider: "easypost", carrier: r.carrier, service: r.service, service_label: `${r.carrier} ${r.service}`, amount_minor: minorFromDecimal(r.rate), currency: (r.currency || req.currency).toUpperCase(), days_min: r.delivery_days ?? null, days_max: r.delivery_days ?? null }));
  },
  async buyLabel(rateId, req, creds): Promise<PurchasedLabel> {
    const [shipmentId, epRate] = rateId.split("|");
    if (!shipmentId || !epRate) throw new ShippingError("invalid", "Unknown EasyPost rate");
    const res = await carrierFetch<{ id: string; tracking_code: string; postage_label?: { label_url?: string }; tracker?: { public_url?: string }; selected_rate?: { carrier: string; service: string; rate: string; currency: string } }>(
      `${BASE}/shipments/${encodeURIComponent(shipmentId)}/buy`,
      { method: "POST", headers: auth(creds), body: { rate: { id: epRate } } },
      "EasyPost label purchase"
    );
    return {
      tracking_number: res.tracking_code,
      tracking_url: safeHttpsUrl(res.tracker?.public_url),
      carrier: res.selected_rate?.carrier ?? "EasyPost",
      service: res.selected_rate?.service ?? "",
      rate_minor: minorFromDecimal(res.selected_rate?.rate),
      currency: (res.selected_rate?.currency ?? req.currency).toUpperCase(),
      provider_ref: `easypost:${res.id}`,
      label_url: safeHttpsUrl(res.postage_label?.label_url),
    };
  },
  async track(ref, creds) {
    const id = ref.provider_ref?.replace(/^easypost:/, "");
    if (!id) return [];
    const res = await carrierFetch<{ tracker?: { tracking_details?: EpDetail[] } }>(`${BASE}/shipments/${encodeURIComponent(id)}`, { headers: auth(creds) }, "EasyPost tracking");
    return toEvents(res.tracker?.tracking_details);
  },
  async void(label, creds) {
    const id = label.provider_ref?.replace(/^easypost:/, "");
    if (!id) return;
    await carrierFetch(`${BASE}/shipments/${encodeURIComponent(id)}/refund`, { method: "POST", headers: auth(creds) }, "EasyPost refund");
  },
  verifyWebhook(rawBody, headers) {
    const secret = process.env.EASYPOST_WEBHOOK_SECRET;
    const header = headers.get("x-hmac-signature");
    if (!secret || !header) return null;
    const expected = `hmac-sha256-hex=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
    if (!safeEqualHex(header, expected)) return null;
    try {
      const j = JSON.parse(rawBody) as { description?: string; result?: { tracking_code?: string; carrier?: string; tracking_details?: EpDetail[] } };
      const r = j.result;
      if (!r?.tracking_code) return [];
      return toEvents(r.tracking_details).map<ParsedWebhook>((event) => ({ tracking_number: r.tracking_code as string, carrier: r.carrier ?? null, event }));
    } catch {
      return [];
    }
  },
};
