import { carrierFetch, envKey, loc, minorFromDecimal } from "./http";
import { safeEqualHex } from "./simulated";
import { safeHttpsUrl, ShippingError, type Address, type CarrierRate, type ParsedWebhook, type ProviderCreds, type PurchasedLabel, type RateRequest, type ShippingProvider, type TrackingEventInput, type TrackStatus } from "../types";

/**
 * Shippo (https://docs.goshippo.com). Implemented against the REST docs; UNTESTED against the live API.
 * Needs SHIPPO_API_KEY (dev fallback) or a per-org key. Shippo does not sign webhooks, so the webhook URL
 * carries `?token=<SHIPPO_WEBHOOK_SECRET>` and is compared in constant time.
 */
const BASE = "https://api.goshippo.com";

function auth(creds: ProviderCreds | null): Record<string, string> {
  const key = creds?.api_key || envKey("SHIPPO_API_KEY");
  if (!key) throw new ShippingError("unavailable", "Shippo is not connected");
  return { Authorization: `ShippoToken ${key}` };
}

const addr = (a: Address) => ({ name: a.name, company: a.company, street1: a.line1, street2: a.line2, city: a.city, state: a.region, zip: a.postal_code, country: a.country, phone: a.phone, email: a.email });

export function mapShippoStatus(s: string | undefined, details?: string): TrackStatus | null {
  switch ((s ?? "").toUpperCase()) {
    case "PRE_TRANSIT": return "label_purchased";
    case "TRANSIT": return /out for delivery/i.test(details ?? "") ? "out_for_delivery" : "in_transit";
    case "DELIVERED": return "delivered";
    case "RETURNED": return "returned";
    case "FAILURE": return "exception";
    default: return null;
  }
}

interface ShTrack { status?: string; status_details?: string; status_date?: string; location?: { city?: string; state?: string; country?: string } }
const toEvents = (h: ShTrack[] | undefined): TrackingEventInput[] =>
  (h ?? []).flatMap((x) => {
    const status = mapShippoStatus(x.status, x.status_details);
    const t = x.status_date ? Date.parse(x.status_date) : NaN;
    return status && Number.isFinite(t) ? [{ status, description: (x.status_details ?? status).slice(0, 300), location: loc(x.location?.city, x.location?.state, x.location?.country), occurred_at: new Date(t).toISOString() }] : [];
  });

export const shippoProvider: ShippingProvider = {
  id: "shippo",
  label: "Shippo",
  configured: (creds) => Boolean(creds?.api_key || envKey("SHIPPO_API_KEY")),
  unavailableReason: () => "Connect a Shippo API token (Shipping → Carriers) or set SHIPPO_API_KEY in development.",
  async rates(req: RateRequest, creds) {
    const p = req.parcel;
    const res = await carrierFetch<{ rates?: Array<{ object_id: string; provider: string; servicelevel?: { name?: string; token?: string }; amount: string; currency: string; estimated_days?: number | null }> }>(
      `${BASE}/shipments/`,
      { method: "POST", headers: auth(creds), body: { address_from: addr(req.from), address_to: addr(req.to), parcels: [{ length: p.length_cm ?? 10, width: p.width_cm ?? 10, height: p.height_cm ?? 10, distance_unit: "cm", weight: p.weight_grams, mass_unit: "g" }], async: false } },
      "Shippo rate request"
    );
    return (res.rates ?? []).map<CarrierRate>((r) => ({ id: r.object_id, provider: "shippo", carrier: r.provider, service: r.servicelevel?.token ?? r.servicelevel?.name ?? "", service_label: `${r.provider} ${r.servicelevel?.name ?? ""}`.trim(), amount_minor: minorFromDecimal(r.amount), currency: (r.currency || req.currency).toUpperCase(), days_min: r.estimated_days ?? null, days_max: r.estimated_days ?? null }));
  },
  async buyLabel(rateId, req, creds): Promise<PurchasedLabel> {
    const res = await carrierFetch<{ object_id: string; status?: string; tracking_number?: string; tracking_url_provider?: string; label_url?: string; rate?: { provider?: string; servicelevel?: { token?: string }; amount?: string; currency?: string }; messages?: unknown }>(
      `${BASE}/transactions/`,
      { method: "POST", headers: auth(creds), body: { rate: rateId, label_file_type: "PDF", async: false } },
      "Shippo label purchase"
    );
    if (res.status !== "SUCCESS" || !res.tracking_number) throw new ShippingError("label_failed", "Shippo did not return a label", 502);
    return {
      tracking_number: res.tracking_number,
      tracking_url: safeHttpsUrl(res.tracking_url_provider),
      carrier: res.rate?.provider ?? "Shippo",
      service: res.rate?.servicelevel?.token ?? "",
      rate_minor: minorFromDecimal(res.rate?.amount),
      currency: (res.rate?.currency ?? req.currency).toUpperCase(),
      provider_ref: `shippo:${res.object_id}`,
      label_url: safeHttpsUrl(res.label_url),
    };
  },
  async track(ref, creds) {
    if (!ref.carrier) return [];
    const res = await carrierFetch<{ tracking_history?: ShTrack[]; tracking_status?: ShTrack }>(`${BASE}/tracks/${encodeURIComponent(ref.carrier.toLowerCase())}/${encodeURIComponent(ref.tracking_number)}`, { headers: auth(creds) }, "Shippo tracking");
    return toEvents([...(res.tracking_history ?? []), ...(res.tracking_status ? [res.tracking_status] : [])]);
  },
  async void(label, creds) {
    const id = label.provider_ref?.replace(/^shippo:/, "");
    if (!id) return;
    await carrierFetch(`${BASE}/refunds/`, { method: "POST", headers: auth(creds), body: { transaction: id, async: false } }, "Shippo refund");
  },
  verifyWebhook(rawBody, _headers, url) {
    const secret = process.env.SHIPPO_WEBHOOK_SECRET;
    const token = url?.searchParams.get("token");
    if (!secret || !token || !safeEqualHex(token, secret)) return null;
    try {
      const j = JSON.parse(rawBody) as { data?: { carrier?: string; tracking_number?: string; tracking_history?: ShTrack[]; tracking_status?: ShTrack } };
      const d = j.data;
      if (!d?.tracking_number) return [];
      return toEvents([...(d.tracking_history ?? []), ...(d.tracking_status ? [d.tracking_status] : [])]).map<ParsedWebhook>((event) => ({ tracking_number: d.tracking_number as string, carrier: d.carrier ?? null, event }));
    } catch {
      return [];
    }
  },
};
