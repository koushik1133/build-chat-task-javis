import type { AdStat } from "./types";

/**
 * Google Ads connector.
 *
 * Google speaks GAQL over REST. `segments.date` gives the same daily grain as
 * the Meta connector, and micros→currency conversion happens here so nothing
 * downstream needs to know Google stores money as millionths.
 */

const API_VERSION = process.env.GOOGLE_ADS_API_VERSION?.trim() || "v18";

export const GOOGLE_ADS_GAQL = `
  SELECT
    campaign.id, campaign.name,
    ad_group.id, ad_group.name,
    ad_group_ad.ad.id, ad_group_ad.ad.name,
    metrics.impressions, metrics.clicks, metrics.cost_micros,
    metrics.conversions, metrics.conversions_value,
    metrics.video_views,
    segments.date
  FROM ad_group_ad
  WHERE segments.date BETWEEN '{since}' AND '{until}'
`;

interface GoogleRow {
  campaign?: { id?: string; name?: string };
  adGroup?: { id?: string; name?: string };
  adGroupAd?: { ad?: { id?: string; name?: string } };
  segments?: { date?: string };
  metrics?: Record<string, string | number | undefined>;
}

const n = (v: unknown) => Number(v) || 0;

export function normaliseGoogleRow(r: GoogleRow): AdStat {
  const m = r.metrics ?? {};
  return {
    platform: "google_ads",
    campaignId: String(r.campaign?.id ?? ""),
    campaignName: String(r.campaign?.name ?? ""),
    adSetId: String(r.adGroup?.id ?? ""),
    adId: String(r.adGroupAd?.ad?.id ?? ""),
    adName: String(r.adGroupAd?.ad?.name ?? r.adGroup?.name ?? ""),
    date: String(r.segments?.date ?? ""),
    impressions: n(m.impressions),
    clicks: n(m.clicks),
    // Google reports money in micros.
    spend: n(m.costMicros) / 1_000_000,
    conversions: n(m.conversions),
    conversionValue: n(m.conversionsValue),
    videoPlays: n(m.videoViews),
    thruPlays: n(m.videoViews),
    // Google Ads does not expose reach/frequency on this report.
    frequency: 0,
    reach: 0,
  };
}

export interface GoogleFetchOptions {
  since: string;
  until: string;
  customerId: string;
  token: string;
  developerToken: string;
  loginCustomerId?: string | null;
}

/** Customer ids are sent without dashes. */
function bareCustomerId(id: string) {
  return id.replace(/-/g, "").trim();
}

export async function fetchGoogleAdStats(opts: GoogleFetchOptions): Promise<AdStat[]> {
  const customerId = bareCustomerId(opts.customerId);

  const res = await fetch(
    `https://googleads.googleapis.com/${API_VERSION}/customers/${customerId}/googleAds:searchStream`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${opts.token}`,
        "developer-token": opts.developerToken,
        ...(opts.loginCustomerId
          ? { "login-customer-id": bareCustomerId(opts.loginCustomerId) }
          : {}),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: GOOGLE_ADS_GAQL.replace("{since}", opts.since).replace("{until}", opts.until),
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
    }
  );

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Google Ads ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
  }

  // searchStream returns an array of chunks, each with its own `results`.
  const payload = (await res.json()) as Array<{ results?: GoogleRow[] }> | { results?: GoogleRow[] };
  const chunks = Array.isArray(payload) ? payload : [payload];

  const rows: AdStat[] = [];
  for (const chunk of chunks) {
    for (const r of chunk.results ?? []) rows.push(normaliseGoogleRow(r));
  }
  return rows;
}
