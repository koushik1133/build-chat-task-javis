import { randomUUID } from "crypto";
import { query, queryOne } from "@/lib/dsql";
import { emitEvent } from "@/lib/events/bus";
import { BOOKING_COLS, type BookingRow } from "@/lib/calendar/booking";
import { bookingSummary } from "./ics";
import { ensureCalsyncCursor, ensureFreshAuth, getCalendarProvider, getConnectionById, type ConnectionRow } from "./connections";
import { parseSyncSettings } from "./types";

const PULL_DAYS = 60;
const DAY = 86_400_000;

function errText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 300);
}

async function recordError(conn: ConnectionRow, err: unknown): Promise<void> {
  const message = errText(err);
  await query(`UPDATE calendar_connections SET status = 'error', last_error = $1 WHERE id = $2`, [message, conn.id]).catch(() => undefined);
  await emitEvent(conn.user_id, { type: "calsync.error", entity: "calendar_connection", entityId: conn.id, data: { provider: conn.provider, error: message } });
}

function targetCalendar(conn: ConnectionRow): string | null {
  return parseSyncSettings(conn.settings).calendar_id ?? conn.external_calendar_id;
}

export type PushAction = "created" | "updated" | "deleted" | "skipped";

/** Create / update / delete the external event for one booking. State-based, so replays are harmless. */
export async function pushBooking(connId: string, bookingId: string): Promise<PushAction> {
  const conn = await getConnectionById(connId);
  if (!conn || conn.status === "disabled") return "skipped";
  const settings = parseSyncSettings(conn.settings);
  if (!settings.push_bookings) return "skipped";
  const calendarId = targetCalendar(conn);
  const provider = getCalendarProvider(conn.provider);
  if (!provider || !calendarId) return "skipped";

  const booking = await queryOne<BookingRow>(`SELECT ${BOOKING_COLS} FROM bookings WHERE id = $1 AND user_id = $2`, [bookingId, conn.user_id]);
  const link = await queryOne<{ id: string; external_event_id: string }>(`SELECT id, external_event_id FROM calendar_event_links WHERE connection_id = $1 AND booking_id = $2`, [connId, bookingId]);
  try {
    const auth = await ensureFreshAuth(conn);
    if (!booking || booking.status === "cancelled") {
      if (!link) return "skipped";
      await provider.deleteEvent(auth, calendarId, link.external_event_id);
      await query(`DELETE FROM calendar_event_links WHERE id = $1`, [link.id]);
      return "deleted";
    }
    const pushEvent = {
      bookingId,
      summary: bookingSummary(booking.name),
      description: "Booked via KernelHub",
      startsAt: new Date(booking.starts_at).toISOString(),
      endsAt: new Date(booking.ends_at).toISOString(),
    };
    let r: { externalId: string; etag: string | null };
    try {
      r = await provider.upsertEvent(auth, calendarId, pushEvent, link?.external_event_id ?? null);
    } catch (err) {
      const status = (err as { status?: number }).status;
      // The external event was deleted by the user: recreate it instead of failing forever.
      if (link && (status === 404 || status === 410)) r = await provider.upsertEvent(auth, calendarId, pushEvent, null);
      else throw err;
    }
    if (link) {
      await query(`UPDATE calendar_event_links SET external_event_id = $1, etag = $2, last_pushed_at = NOW() WHERE id = $3`, [r.externalId, r.etag, link.id]);
      return "updated";
    }
    await query(
      `INSERT INTO calendar_event_links (id, user_id, connection_id, booking_id, external_event_id, etag, last_pushed_at) VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (connection_id, booking_id) DO UPDATE SET external_event_id = EXCLUDED.external_event_id, etag = EXCLUDED.etag, last_pushed_at = NOW()`,
      [randomUUID(), conn.user_id, connId, bookingId, r.externalId, r.etag]
    );
    return "created";
  } catch (err) {
    await recordError(conn, err);
    throw err;
  }
}

/** Replace the stored busy blocks for the next 60 days. Only times and a title hash are kept. */
export async function pullBusy(connId: string, now = new Date()): Promise<{ stored: number; removed: number }> {
  const conn = await getConnectionById(connId);
  if (!conn || conn.status === "disabled") return { stored: 0, removed: 0 };
  const settings = parseSyncSettings(conn.settings);
  const calendarId = targetCalendar(conn);
  const provider = getCalendarProvider(conn.provider);
  if (!settings.pull_busy || !provider || !calendarId) return { stored: 0, removed: 0 };
  const from = new Date(now.getTime() - DAY);
  const to = new Date(now.getTime() + PULL_DAYS * DAY);
  try {
    const auth = await ensureFreshAuth(conn);
    const { blocks, cursor } = await provider.listBusy(auth, calendarId, from, to, conn.sync_cursor);
    const keep = new Set<string>();
    for (const b of blocks) {
      keep.add(b.externalEventId);
      await query(
        `INSERT INTO external_busy (id, user_id, connection_id, external_event_id, starts_at, ends_at, summary_hash, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
         ON CONFLICT (connection_id, external_event_id) DO UPDATE SET starts_at = EXCLUDED.starts_at, ends_at = EXCLUDED.ends_at, summary_hash = EXCLUDED.summary_hash, updated_at = NOW()`,
        [randomUUID(), conn.user_id, connId, b.externalEventId, b.startsAt, b.endsAt, b.summaryHash]
      );
    }
    const existing = await query<{ external_event_id: string }>(`SELECT external_event_id FROM external_busy WHERE connection_id = $1`, [connId]);
    const stale = existing.map((r) => r.external_event_id).filter((id) => !keep.has(id));
    for (const id of stale) await query(`DELETE FROM external_busy WHERE connection_id = $1 AND external_event_id = $2`, [connId, id]);
    await query(`UPDATE calendar_connections SET last_sync_at = NOW(), sync_cursor = $1, status = 'connected', last_error = NULL WHERE id = $2`, [cursor, connId]);
    return { stored: blocks.length, removed: stale.length };
  } catch (err) {
    await recordError(conn, err);
    throw err;
  }
}

/** Push upcoming confirmed bookings that have no link yet (first connect / missed events). */
async function pushMissing(conn: ConnectionRow, limit = 50): Promise<number> {
  if (!parseSyncSettings(conn.settings).push_bookings) return 0;
  const rows = await query<{ id: string }>(
    `SELECT b.id FROM bookings b
      WHERE b.user_id = $1 AND b.status = 'confirmed' AND b.starts_at > NOW()
        AND NOT EXISTS (SELECT 1 FROM calendar_event_links l WHERE l.connection_id = $2 AND l.booking_id = b.id)
      ORDER BY b.starts_at ASC LIMIT $3`,
    [conn.user_id, conn.id, limit]
  );
  let n = 0;
  for (const r of rows) {
    if ((await pushBooking(conn.id, r.id)) === "created") n++;
  }
  // Reconcile existing links: cancelled bookings whose external event is still there, and edits made since the last push
  // (a failed cancel/reschedule push is otherwise never retried because the event cursor moved on).
  const stale = await query<{ id: string }>(
    `SELECT b.id FROM bookings b JOIN calendar_event_links l ON l.booking_id = b.id AND l.connection_id = $2
      WHERE b.user_id = $1 AND b.starts_at > NOW() - INTERVAL '1 day'
        AND (b.status = 'cancelled' OR b.updated_at > l.last_pushed_at)
      ORDER BY b.starts_at ASC LIMIT $3`,
    [conn.user_id, conn.id, limit]
  );
  for (const r of stale) await pushBooking(conn.id, r.id);
  return n;
}

/** One full sync pass for a connection (manual "Sync now" and cron). */
export async function syncConnection(connId: string): Promise<{ pushed: number; busy: number }> {
  const conn = await getConnectionById(connId);
  if (!conn || conn.status === "disabled") return { pushed: 0, busy: 0 };
  const pushed = await pushMissing(conn);
  const { stored } = await pullBusy(connId);
  return { pushed, busy: stored };
}

/** Cron: sync connections whose last sync is older than `staleMinutes`. */
export async function syncDue(limit = 20, staleMinutes = 10): Promise<{ scanned: number; synced: number; failed: number }> {
  const rows = await query<{ id: string }>(
    `SELECT id FROM calendar_connections
      WHERE status <> 'disabled' AND (last_sync_at IS NULL OR last_sync_at < NOW() - ($2 || ' minutes')::interval)
      ORDER BY last_sync_at ASC NULLS FIRST LIMIT $1`,
    [Math.min(Math.max(limit, 1), 100), String(staleMinutes)]
  );
  let synced = 0;
  let failed = 0;
  for (const r of rows) {
    try {
      await syncConnection(r.id);
      synced++;
    } catch {
      failed++;
    }
  }
  return { scanned: rows.length, synced, failed };
}

const PUSH_EVENTS = new Set(["booking.created", "booking.rescheduled", "booking.cancelled"]);

/** Cursor-based event processor (same watermark pattern as webhooks fan-out). */
export async function processCalendarEvents(limit = 200, budgetMs = 25_000): Promise<{ scanned: number; pushed: number; failed: number }> {
  const deadline = Date.now() + budgetMs;
  const cur = await queryOne<{ name: string }>(`SELECT name FROM calsync_cursors WHERE name = 'events'`);
  if (!cur) {
    await ensureCalsyncCursor();
    return { scanned: 0, pushed: 0, failed: 0 };
  }
  const events = await query<{ id: string; user_id: string; type: string; entity_id: string }>(
    `SELECT e.id, e.user_id, e.type, e.entity_id
       FROM events e, calsync_cursors c
      WHERE c.name = 'events'
        AND (e.created_at > COALESCE(c.last_event_at, 'epoch'::timestamptz)
             OR (e.created_at = c.last_event_at AND e.id > COALESCE(c.last_event_id, '')))
      ORDER BY e.created_at ASC, e.id ASC LIMIT $1`,
    [Math.min(Math.max(limit, 1), 1000)]
  );
  if (events.length === 0) return { scanned: 0, pushed: 0, failed: 0 };

  const connsByUser = new Map<string, string[]>();
  let pushed = 0;
  let failed = 0;
  let done = 0;
  for (const evt of events) {
    if (done > 0 && Date.now() > deadline) break; // resume from the next event on the following tick
    done++;
    if (!PUSH_EVENTS.has(evt.type)) continue;
    let ids = connsByUser.get(evt.user_id);
    if (!ids) {
      const rows = await query<ConnectionRow>(
        `SELECT id, settings FROM calendar_connections WHERE user_id = $1 AND status <> 'disabled'`,
        [evt.user_id]
      );
      ids = rows.filter((r) => parseSyncSettings(r.settings).push_bookings).map((r) => r.id);
      connsByUser.set(evt.user_id, ids);
    }
    for (const id of ids) {
      try {
        const a = await pushBooking(id, evt.entity_id);
        if (a !== "skipped") pushed++;
      } catch {
        failed++; // recorded on the connection; the cursor still advances so one bad provider cannot stall the rest
      }
    }
  }
  const last = events[done - 1];
  await query(`UPDATE calsync_cursors SET last_event_at = (SELECT created_at FROM events WHERE id = $2), last_event_id = $2, updated_at = NOW() WHERE name = $1`, ["events", last.id]);
  return { scanned: done, pushed, failed };
}
