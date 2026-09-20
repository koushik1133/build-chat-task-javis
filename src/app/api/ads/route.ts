import { NextResponse } from "next/server";
import { requireUser } from "@/lib/supabase/server";
import { query } from "@/lib/dsql";
import { derive, isAdPlatform, type AdPlatformId } from "@/lib/ads/types";
import { defaultRange } from "@/lib/ads/sync";

export const runtime = "nodejs";

interface StatRow {
  platform: AdPlatformId;
  campaign_id: string | null;
  campaign_name: string | null;
  ad_id: string | null;
  ad_name: string | null;
  stat_date: string;
  impressions: string | number;
  reach: string | number;
  frequency: string | number;
  clicks: string | number;
  spend: string | number;
  conversions: string | number;
  conversion_value: string | number;
}

const n = (v: unknown) => Number(v) || 0;

interface Totals {
  impressions: number;
  reach: number;
  clicks: number;
  spend: number;
  conversions: number;
  conversionValue: number;
}

const emptyTotals = (): Totals => ({
  impressions: 0, reach: 0, clicks: 0, spend: 0, conversions: 0, conversionValue: 0,
});

function accumulate(into: Totals, r: StatRow) {
  into.impressions += n(r.impressions);
  into.reach += n(r.reach);
  into.clicks += n(r.clicks);
  into.spend += n(r.spend);
  into.conversions += n(r.conversions);
  into.conversionValue += n(r.conversion_value);
}

/**
 * GET /api/ads?days=30&platform=meta_ads
 *
 * Returns totals, a daily series and a per-campaign breakdown — all derived
 * from the single normalised `ad_stats` shape, so Meta and Google genuinely
 * share one report rather than sitting in two panels.
 */
export async function GET(req: Request) {
  let user;
  try { ({ user } = await requireUser()); }
  catch { return NextResponse.json({ error: "unauthorized" }, { status: 401 }); }

  const params = new URL(req.url).searchParams;

  const daysRaw = Number(params.get("days") ?? 30);
  const days = Number.isFinite(daysRaw) ? Math.min(Math.max(Math.trunc(daysRaw), 1), 90) : 30;

  const platformParam = params.get("platform");
  const platform = isAdPlatform(platformParam) ? platformParam : null;

  const { since, until } = defaultRange(days);

  const sql = `SELECT platform, campaign_id, campaign_name, ad_id, ad_name, stat_date,
                      impressions, reach, frequency, clicks, spend, conversions, conversion_value
               FROM ad_stats
               WHERE user_id = $1 AND stat_date BETWEEN $2 AND $3
               ${platform ? "AND platform = $4" : ""}
               ORDER BY stat_date ASC`;
  const args: (string | number)[] = platform
    ? [user.id, since, until, platform]
    : [user.id, since, until];

  const rows = await query<StatRow>(sql, args).catch(() => [] as StatRow[]);

  const totals = emptyTotals();
  const byDay = new Map<string, Totals>();
  const byPlatform = new Map<AdPlatformId, Totals>();
  const byCampaign = new Map<string, Totals & { name: string; platform: AdPlatformId }>();

  for (const r of rows) {
    accumulate(totals, r);

    const day = String(r.stat_date).slice(0, 10);
    if (!byDay.has(day)) byDay.set(day, emptyTotals());
    accumulate(byDay.get(day)!, r);

    if (!byPlatform.has(r.platform)) byPlatform.set(r.platform, emptyTotals());
    accumulate(byPlatform.get(r.platform)!, r);

    const key = `${r.platform}:${r.campaign_id ?? "unknown"}`;
    if (!byCampaign.has(key)) {
      byCampaign.set(key, {
        ...emptyTotals(),
        name: r.campaign_name || r.campaign_id || "Untitled campaign",
        platform: r.platform,
      });
    }
    accumulate(byCampaign.get(key)!, r);
  }

  return NextResponse.json({
    since,
    until,
    days,
    platform,
    hasData: rows.length > 0,
    totals: { ...totals, ...derive(totals) },
    series: [...byDay.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, t]) => ({ date, ...t, ...derive(t) })),
    platforms: [...byPlatform.entries()].map(([id, t]) => ({ platform: id, ...t, ...derive(t) })),
    campaigns: [...byCampaign.entries()]
      .map(([id, c]) => ({ id, ...c, ...derive(c) }))
      .sort((a, b) => b.spend - a.spend)
      .slice(0, 50),
  });
}
