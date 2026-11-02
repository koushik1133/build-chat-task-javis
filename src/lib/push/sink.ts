import { randomUUID } from "node:crypto";
import { query } from "@/lib/dsql";
import { tableExists } from "@/lib/table-exists";
import { isPushSubscription, sendWebPush, type PushSubscriptionJSON } from "./send";
import { getVapidConfig, isPushConfigured } from "./vapid";

export { isPushConfigured, getVapidConfig };

/**
 * Push subscription store + fan-out. Subscriptions are keyed by the org data
 * id (`user_id`) so a workspace notification reaches every device of every
 * member who opted in; `member_id` records who subscribed.
 */

export interface PushSubscriptionRow {
  id: string;
  user_id: string;
  member_id: string | null;
  endpoint: string;
  keys: string;
  user_agent: string | null;
  created_at: string;
}

/** Thrown when a caller tries to re-register a push endpoint that another member owns. */
export class PushEndpointOwnedError extends Error {
  constructor() {
    super("push endpoint is registered to another user");
    this.name = "PushEndpointOwnedError";
  }
}

export async function saveSubscription(dataId: string, memberId: string | null, sub: PushSubscriptionJSON, userAgent?: string | null): Promise<string> {
  if (!isPushSubscription(sub)) throw new Error("invalid push subscription");
  const keys = JSON.stringify({ p256dh: sub.keys.p256dh, auth: sub.keys.auth });
  const ua = userAgent?.slice(0, 300) ?? null;
  // Endpoint is unique across workspaces: a device re-subscribing moves to the current org.
  // Only the member who registered the endpoint may move it; otherwise anyone who learned
  // another member's endpoint URL could silently re-bind (and so silence) their device.
  const existing = await query<{ id: string; member_id: string | null }>(`SELECT id, member_id FROM push_subscriptions WHERE endpoint = $1`, [sub.endpoint]);
  if (existing[0]) {
    if (existing[0].member_id && existing[0].member_id !== memberId) throw new PushEndpointOwnedError();
    await query(`UPDATE push_subscriptions SET user_id = $2, member_id = $3, keys = $4, user_agent = $5 WHERE id = $1`, [existing[0].id, dataId, memberId, keys, ua]);
    return existing[0].id;
  }
  const id = randomUUID();
  await query(`INSERT INTO push_subscriptions (id, user_id, member_id, endpoint, keys, user_agent) VALUES ($1,$2,$3,$4,$5,$6)`, [id, dataId, memberId, sub.endpoint, keys, ua]);
  return id;
}

export async function removeSubscription(dataId: string, endpoint: string): Promise<number> {
  const rows = await query<{ id: string }>(`DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2 RETURNING id`, [dataId, endpoint]);
  return rows.length;
}

export async function listSubscriptions(dataId: string, memberId?: string | null): Promise<PushSubscriptionRow[]> {
  if (memberId) {
    return query<PushSubscriptionRow>(`SELECT * FROM push_subscriptions WHERE user_id = $1 AND member_id = $2 ORDER BY created_at DESC`, [dataId, memberId]);
  }
  return query<PushSubscriptionRow>(`SELECT * FROM push_subscriptions WHERE user_id = $1 ORDER BY created_at DESC`, [dataId]);
}

export interface PushMessage {
  title: string;
  body?: string | null;
  /** Path or absolute URL to open on click. */
  url?: string | null;
  /** Collapses notifications with the same tag. */
  tag?: string | null;
  icon?: string | null;
}

export interface DeliverResult {
  sent: number;
  failed: number;
  removed: number;
  configured: boolean;
}

function rowToSubscription(row: PushSubscriptionRow): PushSubscriptionJSON | null {
  try {
    const keys = JSON.parse(row.keys) as { p256dh?: string; auth?: string };
    const sub = { endpoint: row.endpoint, keys: { p256dh: keys.p256dh ?? "", auth: keys.auth ?? "" } };
    return isPushSubscription(sub) ? sub : null;
  } catch {
    return null;
  }
}

/**
 * Send one notification to every device subscribed under `dataId`.
 * Dead endpoints (404/410) are pruned. Never throws.
 */
export async function deliverPushForUser(dataId: string, msg: PushMessage, opts: { memberId?: string | null } = {}): Promise<DeliverResult> {
  const result: DeliverResult = { sent: 0, failed: 0, removed: 0, configured: isPushConfigured() };
  if (!result.configured) return result;
  if (!(await tableExists("push_subscriptions"))) return result;

  let rows: PushSubscriptionRow[] = [];
  try {
    rows = await listSubscriptions(dataId, opts.memberId ?? null);
  } catch (err) {
    console.error("[push] could not list subscriptions:", err);
    return result;
  }
  if (rows.length === 0) return result;

  const payload = {
    title: msg.title.slice(0, 120),
    body: (msg.body ?? "").slice(0, 500),
    url: msg.url ?? "/",
    tag: msg.tag ?? undefined,
    icon: msg.icon ?? "/icons/icon-192.png",
  };

  await Promise.all(
    rows.map(async (row) => {
      try {
        const sub = rowToSubscription(row);
        if (!sub) {
          result.removed++;
          await query(`DELETE FROM push_subscriptions WHERE id = $1`, [row.id]).catch(() => undefined);
          return;
        }
        const res = await sendWebPush(sub, payload, { topic: msg.tag ?? undefined });
        if (res.ok) {
          result.sent++;
          return;
        }
        result.failed++;
        if (res.gone) {
          result.removed++;
          await query(`DELETE FROM push_subscriptions WHERE id = $1`, [row.id]).catch(() => undefined);
        } else {
          console.warn(`[push] ${row.endpoint.slice(0, 60)}… failed (${res.status}): ${res.error ?? ""}`);
        }
      } catch (err) {
        // encryptPayload / header building can throw (oversized payload, odd keys):
        // the sink must never reject, only count the device as failed.
        result.failed++;
        console.warn(`[push] ${row.endpoint.slice(0, 60)}… failed:`, err instanceof Error ? err.message : err);
      }
    })
  );
  return result;
}
