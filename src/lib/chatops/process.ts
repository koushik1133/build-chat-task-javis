import { query, queryOne } from "@/lib/dsql";
import { appOrigin } from "@/lib/share-tokens";
import { describeEvent } from "./format";
import { sendChat } from "./send";
import { integrationMatches, parseEvents, type ChatIntegrationRow } from "./subscriptions";

const CURSOR = "events";

async function ensureCursor(): Promise<void> {
  await query(`INSERT INTO chat_cursors (name, last_event_at, last_event_id, updated_at) VALUES ($1, NOW(), '', NOW()) ON CONFLICT (name) DO NOTHING`, [CURSOR]);
}

/** Event types the chat processor never relays (prevents failure-notification loops). */
const SKIP = new Set(["chat.delivery_failed"]);

/**
 * Cron: relay new `events` to matching enabled chat integrations. Advances a
 * (created_at, id) watermark in `chat_cursors`, so each event is considered
 * exactly once and a re-run with no new events sends nothing.
 */
export async function processChatEvents(limit = 200, budgetMs = 25_000): Promise<{ scanned: number; sent: number; failed: number }> {
  const deadline = Date.now() + budgetMs;
  const cur = await queryOne<{ name: string }>(`SELECT name FROM chat_cursors WHERE name = $1`, [CURSOR]);
  if (!cur) {
    await ensureCursor();
    return { scanned: 0, sent: 0, failed: 0 };
  }
  const events = await query<{ id: string; user_id: string; type: string; entity: string; entity_id: string; data: string | null }>(
    `SELECT e.id, e.user_id, e.type, e.entity, e.entity_id, e.data
       FROM events e, chat_cursors c
      WHERE c.name = $1
        AND (e.created_at > COALESCE(c.last_event_at, 'epoch'::timestamptz)
             OR (e.created_at = c.last_event_at AND e.id > COALESCE(c.last_event_id, '')))
      ORDER BY e.created_at ASC, e.id ASC LIMIT $2`,
    [CURSOR, Math.min(Math.max(limit, 1), 1000)]
  );
  if (events.length === 0) return { scanned: 0, sent: 0, failed: 0 };

  const byUser = new Map<string, ChatIntegrationRow[]>();
  let sent = 0;
  let failed = 0;
  let done = 0; // events fully handled; the cursor only advances past these so a timeout never re-sends or skips
  for (const evt of events) {
    if (done > 0 && Date.now() > deadline) break;
    done++;
    if (SKIP.has(evt.type)) continue;
    let list = byUser.get(evt.user_id);
    if (!list) {
      list = await query<ChatIntegrationRow>(
        `SELECT id, user_id, provider, name, webhook_url_enc, channel_label, events, enabled, last_status, last_error, created_at FROM chat_integrations WHERE user_id = $1 AND enabled = TRUE`,
        [evt.user_id]
      );
      byUser.set(evt.user_id, list);
    }
    const targets = list.filter((i) => integrationMatches(parseEvents(i.events), evt.type));
    if (!targets.length) continue;
    let data: Record<string, unknown> = {};
    try {
      const v = evt.data ? (JSON.parse(evt.data) as unknown) : {};
      if (v && typeof v === "object" && !Array.isArray(v)) data = v as Record<string, unknown>;
    } catch {
      /* empty payload */
    }
    const message = describeEvent({ type: evt.type, entity: evt.entity, entity_id: evt.entity_id, data }, appOrigin());
    const results = await Promise.all(targets.map((t) => sendChat(t.id, message).catch(() => ({ ok: false }))));
    for (const r of results) {
      if (r.ok) sent++;
      else failed++;
    }
  }
  const last = events[done - 1];
  await query(`UPDATE chat_cursors SET last_event_at = (SELECT created_at FROM events WHERE id = $2), last_event_id = $2, updated_at = NOW() WHERE name = $1`, [CURSOR, last.id]);
  return { scanned: done, sent, failed };
}
