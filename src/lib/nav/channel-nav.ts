import { query } from "@/lib/dsql";
import { sortChannelIds, toChannelId, getChannel } from "@/lib/channels/registry";

/** A channel the signed-in user has actually connected. */
export interface ChannelNavItem {
  id: string;
  label: string;
  accountCount: number;
}

/**
 * Build the CHANNELS nav group for one user.
 *
 * `userId` is the first parameter and there is no other way to call this, so a
 * caller cannot accidentally build another tenant's navigation.
 */
export async function buildChannelNav(userId: string): Promise<ChannelNavItem[]> {
  const rows = await query<{ platform: string; count: string | number }>(
    `SELECT platform, COUNT(*) AS count
     FROM social_accounts
     WHERE user_id = $1 AND connected = TRUE
     GROUP BY platform`,
    [userId]
  ).catch(() => []);

  // Fold aliases (twitter -> x) together so one network is one nav entry.
  const counts = new Map<string, number>();
  for (const row of rows) {
    const id = toChannelId(row.platform);
    if (!id) continue; // unknown platform string: never render an unreachable link
    counts.set(id, (counts.get(id) ?? 0) + (Number(row.count) || 0));
  }

  return sortChannelIds([...counts.keys()]).map((id) => ({
    id,
    label: getChannel(id)?.label ?? id,
    accountCount: counts.get(id) ?? 0,
  }));
}
