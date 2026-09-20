/** Platforms the ads module can report on. */
export type AdPlatformId = "meta_ads" | "google_ads";

export const AD_PLATFORMS: { id: AdPlatformId; label: string }[] = [
  { id: "meta_ads", label: "Meta Ads" },
  { id: "google_ads", label: "Google Ads" },
];

export function isAdPlatform(v: unknown): v is AdPlatformId {
  return v === "meta_ads" || v === "google_ads";
}

/**
 * One ad, one day, one platform.
 *
 * Meta and Google model campaigns very differently; both are normalised into
 * this single row shape at the edge so every chart and aggregate downstream
 * works off one structure rather than branching per platform.
 */
export interface AdStat {
  platform: AdPlatformId;
  campaignId: string;
  campaignName: string;
  adSetId: string;
  adId: string;
  adName: string;
  /** ISO date, YYYY-MM-DD. */
  date: string;
  impressions: number;
  reach: number;
  /** Meta: average times one person saw the ad — the creative-fatigue signal. */
  frequency: number;
  clicks: number;
  spend: number;
  conversions: number;
  conversionValue: number;
  videoPlays: number;
  thruPlays: number;
}

/** Derived metrics, computed once so the UI never divides by zero itself. */
export interface AdDerived {
  ctr: number;
  cpc: number;
  cpm: number;
  cpa: number;
  roas: number;
}

export function derive(s: {
  impressions: number;
  clicks: number;
  spend: number;
  conversions: number;
  conversionValue: number;
}): AdDerived {
  const safe = (n: number, d: number) => (d > 0 ? n / d : 0);
  return {
    ctr: safe(s.clicks, s.impressions) * 100,
    cpc: safe(s.spend, s.clicks),
    cpm: safe(s.spend, s.impressions) * 1000,
    cpa: safe(s.spend, s.conversions),
    roas: safe(s.conversionValue, s.spend),
  };
}
