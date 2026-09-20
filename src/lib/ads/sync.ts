import { randomUUID } from "crypto";
import { query } from "@/lib/dsql";
import { decryptSecret, redactSecrets } from "@/lib/secure-store";
import { fetchMetaAdStats } from "./meta";
import { fetchGoogleAdStats } from "./google";
import type { AdPlatformId, AdStat } from "./types";

export interface AdAccountRow {
  id: string;
  user_id: string;
  platform: AdPlatformId;
  account_id: string;
  account_name: string | null;
  access_token_enc: string | null;
  developer_token_enc: string | null;
  login_customer_id: string | null;
  connected: boolean;
  last_synced_at: string | null;
  last_sync_error: string | null;
}

export interface SyncResult {
  accountId: string;
  platform: AdPlatformId;
  rows: number;
  ok: boolean;
  error?: string;
}

/** YYYY-MM-DD, UTC. */
export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Default window: the last `days` days inclusive of today. */
export function defaultRange(days: number): { since: string; until: string } {
  const until = new Date();
  const since = new Date(until.getTime() - (days - 1) * 86_400_000);
  return { since: isoDate(since), until: isoDate(until) };
}

/**
 * DSQL has no `ON CONFLICT` upsert on async indexes, so re-syncing a window
 * deletes that window's rows for the account first. `stat_key` still guards
 * against duplicates within a single write batch.
 */
async function replaceWindow(
  userId: string,
  adAccountId: string,
  since: string,
  until: string,
  stats: AdStat[]
): Promise<number> {
  await query(
    `DELETE FROM ad_stats
     WHERE user_id = $1 AND ad_account_id = $2 AND stat_date BETWEEN $3 AND $4`,
    [userId, adAccountId, since, until]
  );

  const seen = new Set<string>();
  let written = 0;

  for (const s of stats) {
    if (!s.date) continue;
    const statKey = `${adAccountId}:${s.adId}:${s.date}`;
    if (seen.has(statKey)) continue;
    seen.add(statKey);

    await query(
      `INSERT INTO ad_stats (
         id, user_id, ad_account_id, stat_key, platform,
         campaign_id, campaign_name, ad_set_id, ad_id, ad_name, stat_date,
         impressions, reach, frequency, clicks, spend,
         conversions, conversion_value, video_plays, thru_plays
       ) VALUES (
         $1,$2,$3,$4,$5,
         $6,$7,$8,$9,$10,$11,
         $12,$13,$14,$15,$16,
         $17,$18,$19,$20
       )`,
      [
        randomUUID(), userId, adAccountId, statKey, s.platform,
        s.campaignId, s.campaignName, s.adSetId, s.adId, s.adName, s.date,
        s.impressions, s.reach, s.frequency, s.clicks, s.spend,
        s.conversions, s.conversionValue, s.videoPlays, s.thruPlays,
      ]
    );
    written++;
  }

  return written;
}

/**
 * Pull one account's stats for a window and persist them.
 *
 * Never throws: a failure is recorded on the account row and returned, so one
 * broken connection can't abort a multi-account sync.
 */
export async function syncAdAccount(
  account: AdAccountRow,
  since: string,
  until: string
): Promise<SyncResult> {
  const base = { accountId: account.id, platform: account.platform };

  // Held so any upstream error text can be scrubbed of them before storage.
  let token: string | null = null;
  let developerToken: string | null = null;

  try {
    token = decryptSecret(account.access_token_enc);
    if (!token) {
      throw new Error("Stored access token is missing or could not be decrypted. Reconnect the account.");
    }

    let stats: AdStat[];
    if (account.platform === "meta_ads") {
      stats = await fetchMetaAdStats({
        since, until, accountId: account.account_id, token,
      });
    } else {
      developerToken = decryptSecret(account.developer_token_enc);
      if (!developerToken) {
        throw new Error("Google Ads developer token is missing. Reconnect the account.");
      }
      stats = await fetchGoogleAdStats({
        since, until,
        customerId: account.account_id,
        token,
        developerToken,
        loginCustomerId: account.login_customer_id,
      });
    }

    const rows = await replaceWindow(account.user_id, account.id, since, until, stats);

    await query(
      `UPDATE ad_accounts SET last_synced_at = NOW(), last_sync_error = NULL, updated_at = NOW()
       WHERE id = $1 AND user_id = $2`,
      [account.id, account.user_id]
    );

    return { ...base, rows, ok: true };
  } catch (err) {
    // Providers echo the offending token back in their error body, so redact
    // before this text is persisted, returned by the API, or rendered.
    const message = redactSecrets(
      err instanceof Error ? err.message : String(err),
      [token, developerToken]
    );
    console.error(`[ads] sync failed for ${account.platform} ${account.account_id}:`, err);
    await query(
      `UPDATE ad_accounts SET last_sync_error = $3, updated_at = NOW()
       WHERE id = $1 AND user_id = $2`,
      [account.id, account.user_id, message.slice(0, 500)]
    ).catch(() => {});
    return { ...base, rows: 0, ok: false, error: message };
  }
}

/** Sync every connected account for a user. */
export async function syncAllForUser(
  userId: string,
  since: string,
  until: string
): Promise<SyncResult[]> {
  const accounts = await query<AdAccountRow>(
    `SELECT * FROM ad_accounts WHERE user_id = $1 AND connected = TRUE`,
    [userId]
  );
  const results: SyncResult[] = [];
  for (const account of accounts) {
    results.push(await syncAdAccount(account, since, until));
  }
  return results;
}
