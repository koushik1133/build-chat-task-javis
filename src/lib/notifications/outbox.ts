import { randomUUID } from "crypto";
import { query, queryOne, withRetry } from "@/lib/dsql";
import { dispatch } from "./channels";
import { isNotificationChannel, type NotificationChannel } from "./status";
import { keysetClause, keysetOrder, type Cursor } from "@/lib/public-api/pagination";
import { notificationAllowed } from "./preferences";

/**
 * Notification outbox: every outbound message is a row first, then the cron
 * tick drains it through the channel senders. Simulated sends keep the body so
 * OTPs and invite links are readable in Settings → Outbox during development.
 */

export type OutboxStatus = "queued" | "sent" | "simulated" | "failed" | "read";

export interface OutboxRow {
  id: string;
  user_id: string;
  channel: NotificationChannel;
  recipient: string;
  subject: string | null;
  body: string | null;
  data: string | null;
  status: OutboxStatus;
  attempts: number | null;
  error: string | null;
  scheduled_at: string;
  sent_at: string | null;
  read_at: string | null;
  created_at: string;
}

export interface EnqueueInput {
  channel: NotificationChannel;
  recipient: string;
  subject?: string | null;
  body?: string | null;
  data?: Record<string, unknown> | null;
  scheduledAt?: Date | string | null;
}

const MAX_ATTEMPTS = 3;

/** Returned instead of an outbox id when the member's preferences turned the channel off (no row is written). */
export const SKIPPED_PREFIX = "skipped:";

export async function enqueueNotification(dataId: string, input: EnqueueInput): Promise<string> {
  if (!isNotificationChannel(input.channel)) throw new Error(`unknown channel ${String(input.channel)}`);
  if (!input.recipient?.trim()) throw new Error("recipient is required");
  const id = randomUUID();
  let scheduled = input.scheduledAt ? new Date(input.scheduledAt) : new Date();
  // Preference gate: notifications that name a member (`data.member_user_id`) and a category
  // (`data.category`) honour that member's channel matrix and quiet hours.
  const category = input.data?.category;
  const member = input.data?.member_user_id;
  if (typeof category === "string" && typeof member === "string" && member) {
    const prefChannel = input.channel === "whatsapp" ? "sms" : input.channel;
    const decision = await notificationAllowed(dataId, member, category, prefChannel);
    if (!decision.allowed) return `${SKIPPED_PREFIX}${id}`;
    if (decision.deferUntil && decision.deferUntil.getTime() > scheduled.getTime()) scheduled = decision.deferUntil;
  }
  await query(
    `INSERT INTO notification_outbox (id, user_id, channel, recipient, subject, body, data, status, attempts, scheduled_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'queued', 0, $8)`,
    [
      id,
      dataId,
      input.channel,
      input.recipient.trim(),
      input.subject ?? null,
      input.body ?? null,
      input.data ? JSON.stringify(input.data) : null,
      scheduled.toISOString(),
    ]
  );
  return id;
}

export function parseOutboxData(row: Pick<OutboxRow, "data">): Record<string, unknown> | null {
  if (!row.data) return null;
  try {
    const v = JSON.parse(row.data);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export interface DrainResult {
  claimed: number;
  sent: number;
  simulated: number;
  failed: number;
}

/**
 * Deliver up to `limit` due rows. Each row is claimed with a conditional
 * UPDATE so concurrent ticks never double-send. Never throws.
 */
export async function drainOutbox(limit = 50): Promise<DrainResult> {
  const result: DrainResult = { claimed: 0, sent: 0, simulated: 0, failed: 0 };
  let due: Array<{ id: string }> = [];
  try {
    due = await query<{ id: string }>(
      `SELECT id FROM notification_outbox
        WHERE status = 'queued' AND scheduled_at <= NOW()
        ORDER BY scheduled_at ASC LIMIT $1`,
      [Math.max(1, Math.min(500, limit))]
    );
  } catch (err) {
    console.error("[outbox] could not list due rows:", err);
    return result;
  }

  for (const { id } of due) {
    let row: OutboxRow | null = null;
    try {
      row = await withRetry(() =>
        queryOne<OutboxRow>(
          `UPDATE notification_outbox
              SET attempts = COALESCE(attempts, 0) + 1
            WHERE id = $1 AND status = 'queued'
            RETURNING *`,
          [id]
        )
      );
    } catch (err) {
      console.error(`[outbox] claim ${id} failed:`, err);
      continue;
    }
    if (!row) continue; // another worker took it
    result.claimed++;

    try {
      const outcome = await dispatch({
        channel: row.channel,
        recipient: row.recipient,
        subject: row.subject,
        body: row.body,
        data: parseOutboxData(row),
        ownerId: row.user_id,
      });
      await query(
        `UPDATE notification_outbox SET status = $2, sent_at = NOW(), error = NULL WHERE id = $1`,
        [id, outcome.status]
      );
      if (outcome.status === "sent") result.sent++;
      else result.simulated++;
    } catch (err) {
      const message = (err instanceof Error ? err.message : String(err)).slice(0, 1000);
      const attempts = Number(row.attempts ?? 1);
      const final = attempts >= MAX_ATTEMPTS;
      await query(
        `UPDATE notification_outbox SET status = $2, error = $3 WHERE id = $1`,
        [id, final ? "failed" : "queued", message]
      ).catch((e) => console.error(`[outbox] could not record failure for ${id}:`, e));
      if (final) result.failed++;
      console.error(`[outbox] ${row.channel} → ${row.recipient} failed (attempt ${attempts}):`, message);
    }
  }
  return result;
}

export interface ListOutboxOptions {
  channel?: NotificationChannel | null;
  status?: OutboxStatus | null;
  /** Only unread in-app rows (status sent, read_at null). */
  unreadInApp?: boolean;
  limit?: number;
  /** Keyset cursor (created_at, id). */
  cursor?: Cursor | null;
}

export async function listOutbox(dataId: string, opts: ListOutboxOptions = {}): Promise<OutboxRow[]> {
  const where: string[] = ["user_id = $1"];
  const values: unknown[] = [dataId];
  if (opts.unreadInApp) {
    where.push(`channel = 'in_app'`, `status = 'sent'`, `read_at IS NULL`, `(snoozed_until IS NULL OR snoozed_until <= NOW())`);
  } else {
    if (opts.channel) {
      values.push(opts.channel);
      where.push(`channel = $${values.length}`);
    }
    if (opts.status) {
      values.push(opts.status);
      where.push(`status = $${values.length}`);
    }
  }
  const keyset = keysetClause(opts.cursor, values);
  values.push(Math.min(201, Math.max(1, opts.limit ?? 50)));
  return query<OutboxRow>(
    `SELECT * FROM notification_outbox WHERE ${where.join(" AND ")}${keyset}
      ORDER BY ${keysetOrder()} LIMIT $${values.length}`,
    values
  );
}

export async function countUnreadInApp(dataId: string): Promise<number> {
  const row = await queryOne<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM notification_outbox
      WHERE user_id = $1 AND channel = 'in_app' AND status = 'sent' AND read_at IS NULL
        AND (snoozed_until IS NULL OR snoozed_until <= NOW())`,
    [dataId]
  );
  return parseInt(row?.count ?? "0", 10);
}

export async function markInAppRead(dataId: string, ids: string[] | "all"): Promise<void> {
  if (ids === "all") {
    await query(
      `UPDATE notification_outbox SET status = 'read', read_at = NOW()
        WHERE user_id = $1 AND channel = 'in_app' AND read_at IS NULL`,
      [dataId]
    );
    return;
  }
  const list = ids.slice(0, 200).map(String);
  if (list.length === 0) return;
  await query(
    `UPDATE notification_outbox SET status = 'read', read_at = NOW()
      WHERE user_id = $1 AND channel = 'in_app' AND read_at IS NULL AND id = ANY($2)`,
    [dataId, list]
  );
}
