import { query, queryOne } from "@/lib/dsql";
import { escapeLike } from "@/lib/like";
import { keysetClause, keysetOrder, type Cursor } from "@/lib/public-api/pagination";
import { parseOutboxData, type OutboxRow } from "@/lib/notifications/outbox";
import { categoryOf, linkOf, snoozeUntil, type InboxItem, type SnoozeKind } from "./pure";

/** SQL fragment: rows addressed to everyone in the org, or specifically to this member. */
function memberClause(member: string, values: unknown[]): string {
  values.push(`%"member_user_id":"${escapeLike(member)}"%`);
  return `(data IS NULL OR data NOT LIKE '%"member_user_id"%' OR data LIKE $${values.length})`;
}

export interface InboxFilters {
  unread?: boolean;
  category?: string | null;
  limit?: number;
  cursor?: Cursor | null;
}

type InboxRow = OutboxRow & { snoozed_until: string | null };

function toItem(r: InboxRow): InboxItem {
  const data = parseOutboxData(r);
  return {
    id: r.id,
    title: r.subject ?? "Notification",
    body: r.body,
    category: categoryOf(data),
    read: r.read_at != null,
    created_at: r.created_at,
    snoozed_until: r.snoozed_until,
    href: linkOf(data),
  };
}

/** In-app notifications for one member: delivered, not currently snoozed. */
export async function listInbox(dataId: string, member: string, f: InboxFilters = {}): Promise<InboxItem[]> {
  const values: unknown[] = [dataId];
  const where = [`user_id = $1`, `channel = 'in_app'`, `status IN ('sent','read')`, `(snoozed_until IS NULL OR snoozed_until <= NOW())`, memberClause(member, values)];
  if (f.unread) where.push(`read_at IS NULL`);
  if (f.category) {
    values.push(`%"category":"${escapeLike(f.category.replace(/[^a-z_]/gi, ""))}"%`);
    where.push(`data LIKE $${values.length}`);
  }
  const keyset = keysetClause(f.cursor, values);
  values.push(Math.min(101, Math.max(1, f.limit ?? 51)));
  const rows = await query<InboxRow>(
    `SELECT * FROM notification_outbox WHERE ${where.join(" AND ")}${keyset} ORDER BY ${keysetOrder()} LIMIT $${values.length}`,
    values
  );
  return rows.map(toItem);
}

export async function inboxUnreadCount(dataId: string, member: string): Promise<number> {
  const values: unknown[] = [dataId];
  const clause = memberClause(member, values);
  const row = await queryOne<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM notification_outbox
      WHERE user_id = $1 AND channel = 'in_app' AND status = 'sent' AND read_at IS NULL
        AND (snoozed_until IS NULL OR snoozed_until <= NOW()) AND ${clause}`,
    values
  );
  return parseInt(row?.count ?? "0", 10);
}

/** Restrict a bulk id list to rows this member may see (prevents cross-member writes). */
async function visibleIds(dataId: string, member: string, ids: string[]): Promise<string[]> {
  const values: unknown[] = [dataId, ids.slice(0, 200)];
  const clause = memberClause(member, values);
  const rows = await query<{ id: string }>(
    `SELECT id FROM notification_outbox WHERE user_id = $1 AND channel = 'in_app' AND id = ANY($2) AND ${clause}`,
    values
  );
  return rows.map((r) => r.id);
}

export async function markRead(dataId: string, member: string, ids: string[] | "all"): Promise<number> {
  if (ids === "all") {
    const values: unknown[] = [dataId];
    const clause = memberClause(member, values);
    const rows = await query<{ id: string }>(
      `UPDATE notification_outbox SET status = 'read', read_at = NOW()
        WHERE user_id = $1 AND channel = 'in_app' AND read_at IS NULL AND ${clause} RETURNING id`,
      values
    );
    return rows.length;
  }
  const ok = await visibleIds(dataId, member, ids);
  if (!ok.length) return 0;
  const rows = await query<{ id: string }>(
    `UPDATE notification_outbox SET status = 'read', read_at = NOW()
      WHERE user_id = $1 AND channel = 'in_app' AND read_at IS NULL AND id = ANY($2) RETURNING id`,
    [dataId, ok]
  );
  return rows.length;
}

export async function snooze(dataId: string, member: string, ids: string[], kind: SnoozeKind, tzOffsetMinutes: number, now = new Date()): Promise<{ count: number; until: string }> {
  const until = snoozeUntil(kind, now, tzOffsetMinutes);
  const ok = await visibleIds(dataId, member, ids);
  if (!ok.length) return { count: 0, until: until.toISOString() };
  const rows = await query<{ id: string }>(
    `UPDATE notification_outbox SET snoozed_until = $3
      WHERE user_id = $1 AND channel = 'in_app' AND read_at IS NULL AND id = ANY($2) RETURNING id`,
    [dataId, ok, until.toISOString()]
  );
  return { count: rows.length, until: until.toISOString() };
}

/** "Assigned to me" digest: cheap counts only. */
export async function assignedDigest(dataId: string, member: string): Promise<{ open_tasks: number; overdue_tasks: number }> {
  try {
    const row = await queryOne<{ open: string; overdue: string }>(
      `SELECT COUNT(*)::text AS open, COUNT(*) FILTER (WHERE due_at IS NOT NULL AND due_at < NOW())::text AS overdue
         FROM tasks WHERE user_id = $1 AND assignee_id = $2 AND done = false`,
      [dataId, member]
    );
    return { open_tasks: parseInt(row?.open ?? "0", 10), overdue_tasks: parseInt(row?.overdue ?? "0", 10) };
  } catch {
    return { open_tasks: 0, overdue_tasks: 0 };
  }
}
