import type { AdStat } from "./types";

/**
 * Meta Marketing API connector.
 *
 * Credentials are passed in per call — the platform is multi-tenant, so there
 * is no single account-wide token.
 */

const GRAPH_VERSION = process.env.META_GRAPH_VERSION?.trim() || "v21.0";

/** Enough fields to derive ROAS, creative fatigue and CPM drift. */
export const META_INSIGHT_FIELDS = [
  "campaign_id",
  "campaign_name",
  "adset_id",
  "adset_name",
  "ad_id",
  "ad_name",
  "impressions",
  "reach",
  "frequency",
  "clicks",
  "inline_link_clicks",
  "spend",
  "actions",
  "action_values",
  "video_play_actions",
  "video_thruplay_watched_actions",
].join(",");

const CONVERSION_ACTIONS = [
  "purchase",
  "offsite_conversion.fb_pixel_purchase",
  "lead",
  "offsite_conversion.fb_pixel_lead",
  "onsite_conversion.messaging_conversation_started_7d",
];

/** Pull a conversion count/value out of Meta's `actions` / `action_values` arrays. */
function sumActions(list: unknown, types: string[]): number {
  if (!Array.isArray(list)) return 0;
  return (list as Array<{ action_type?: string; value?: string }>)
    .filter((a) => types.includes(a.action_type ?? ""))
    .reduce((sum, a) => sum + (Number(a.value) || 0), 0);
}

const n = (v: unknown) => Number(v) || 0;

export function normaliseMetaRow(r: Record<string, unknown>): AdStat {
  return {
    platform: "meta_ads",
    campaignId: String(r.campaign_id ?? ""),
    campaignName: String(r.campaign_name ?? ""),
    adSetId: String(r.adset_id ?? ""),
    adId: String(r.ad_id ?? ""),
    adName: String(r.ad_name ?? ""),
    date: String(r.date_start ?? ""),
    impressions: n(r.impressions),
    reach: n(r.reach),
    frequency: n(r.frequency),
    // inline_link_clicks is the meaningful click for traffic ads; fall back to all clicks.
    clicks: n(r.inline_link_clicks) || n(r.clicks),
    spend: n(r.spend),
    conversions: sumActions(r.actions, CONVERSION_ACTIONS),
    conversionValue: sumActions(r.action_values, CONVERSION_ACTIONS),
    videoPlays: sumActions(r.video_play_actions, ["video_view"]),
    thruPlays: sumActions(r.video_thruplay_watched_actions, ["video_view"]),
  };
}

export interface MetaFetchOptions {
  since: string;
  until: string;
  accountId: string;
  token: string;
  /** Safety valve so one bad account can't page forever. */
  maxPages?: number;
}

/**
 * `level=ad` with a daily `time_increment` gives one row per ad per day — the
 * finest grain still available on the API's synchronous path for one account.
 */
export async function fetchMetaAdStats(opts: MetaFetchOptions): Promise<AdStat[]> {
  const accountId = opts.accountId.startsWith("act_") ? opts.accountId : `act_${opts.accountId}`;
  const url = new URL(`https://graph.facebook.com/${GRAPH_VERSION}/${accountId}/insights`);
  url.search = new URLSearchParams({
    level: "ad",
    time_increment: "1",
    limit: "500",
    fields: META_INSIGHT_FIELDS,
    time_range: JSON.stringify({ since: opts.since, until: opts.until }),
  }).toString();

  const rows: AdStat[] = [];
  let next: string | undefined = url.toString();
  let page = 0;
  const maxPages = opts.maxPages ?? 20;

  while (next && page < maxPages) {
    // The token goes in the header rather than the query string so it never
    // lands in an intermediary's access log.
    const res: Response = await fetch(next, {
      headers: { Authorization: `Bearer ${opts.token}` },
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Meta insights ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
    }

    const json = (await res.json()) as {
      data?: Record<string, unknown>[];
      paging?: { next?: string };
    };
    for (const r of json.data ?? []) rows.push(normaliseMetaRow(r));
    next = json.paging?.next;
    page++;
  }

  return rows;
}
