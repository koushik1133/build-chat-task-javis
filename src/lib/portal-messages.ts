import { randomUUID } from "crypto";
import { query, queryOne } from "@/lib/dsql";
import { emitEvent } from "@/lib/events/bus";
import { enqueueNotification } from "@/lib/notifications/outbox";
import { appOrigin, issueShareToken } from "@/lib/share-tokens";
import { tableExists } from "@/lib/table-exists";
import { validateMessageBody } from "@/lib/portal-rules";
import { keysetClause, keysetOrder, type Cursor } from "@/lib/public-api/pagination";

/**
 * Portal messaging: a per-contact thread between the customer (portal token)
 * and staff. Rows are keyed by the org data id like every module table.
 */

export interface PortalMessageRow {
  id: string;
  user_id: string;
  contact_id: string;
  direction: "in" | "out";
  body: string;
  author_member_id: string | null;
  read_at: string | null;
  created_at: string;
}

/** Public shape: no user_id, no staff member ids. */
export interface PortalMessageDTO {
  id: string;
  direction: "in" | "out";
  body: string;
  read: boolean;
  created_at: string;
}

const COLS = "id, user_id, contact_id, direction, body, author_member_id, read_at, created_at";

export class PortalMessageError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "PortalMessageError";
  }
}

export function toPublicMessage(m: PortalMessageRow): PortalMessageDTO {
  return { id: m.id, direction: m.direction, body: m.body, read: Boolean(m.read_at), created_at: new Date(m.created_at).toISOString() };
}

/** Thread for one contact, oldest first. `since` is an ISO cursor (exclusive) on created_at. */
export async function listThread(dataId: string, contactId: string, opts: { since?: string | null; limit?: number } = {}): Promise<PortalMessageRow[]> {
  if (!(await tableExists("portal_messages"))) return [];
  const params: unknown[] = [dataId, contactId];
  let sql = `SELECT ${COLS} FROM portal_messages WHERE user_id = $1 AND contact_id = $2`;
  if (opts.since && !Number.isNaN(Date.parse(opts.since))) {
    params.push(opts.since);
    sql += ` AND created_at > $${params.length}`;
  }
  params.push(Math.min(Math.max(opts.limit ?? 100, 1), 200));
  // Newest N, returned oldest-first.
  const rows = await query<PortalMessageRow>(`${sql} ORDER BY created_at DESC, id DESC LIMIT $${params.length}`, params);
  return rows.reverse();
}

/** Contact reads staff replies: mark outbound messages read. */
export async function markReadByContact(dataId: string, contactId: string): Promise<void> {
  if (!(await tableExists("portal_messages"))) return;
  await query(`UPDATE portal_messages SET read_at = NOW() WHERE user_id = $1 AND contact_id = $2 AND direction = 'out' AND read_at IS NULL`, [dataId, contactId]);
}

/** Staff read customer messages. */
export async function markReadByStaff(dataId: string, contactId: string): Promise<number> {
  if (!(await tableExists("portal_messages"))) return 0;
  const rows = await query<{ id: string }>(
    `UPDATE portal_messages SET read_at = NOW() WHERE user_id = $1 AND contact_id = $2 AND direction = 'in' AND read_at IS NULL RETURNING id`,
    [dataId, contactId]
  );
  return rows.length;
}

/** Unread staff replies waiting for the contact. */
export async function unreadForContact(dataId: string, contactId: string): Promise<number> {
  if (!(await tableExists("portal_messages"))) return 0;
  const r = await queryOne<{ n: string }>(`SELECT COUNT(*)::text AS n FROM portal_messages WHERE user_id = $1 AND contact_id = $2 AND direction = 'out' AND read_at IS NULL`, [dataId, contactId]);
  return Number(r?.n ?? 0);
}

/** Customer → staff. Emits portal.message_received and notifies staff in-app. */
export async function receiveFromContact(dataId: string, contactId: string, rawBody: unknown): Promise<PortalMessageRow> {
  const check = validateMessageBody(rawBody);
  if (!check.ok) throw new PortalMessageError(check.error, 400);
  const contact = await queryOne<{ full_name: string }>(`SELECT full_name FROM crm_contacts WHERE user_id = $1 AND id = $2`, [dataId, contactId]);
  if (!contact) throw new PortalMessageError("not_found", 404);
  const id = randomUUID();
  await query(`INSERT INTO portal_messages (id, user_id, contact_id, direction, body) VALUES ($1, $2, $3, 'in', $4)`, [id, dataId, contactId, check.body]);
  const row = (await queryOne<PortalMessageRow>(`SELECT ${COLS} FROM portal_messages WHERE id = $1`, [id])) as PortalMessageRow;
  await emitEvent(dataId, {
    type: "portal.message_received",
    entity: "portal_message",
    entityId: id,
    data: { contactId, contactName: contact.full_name, preview: check.body.slice(0, 200) },
  });
  try {
    await enqueueNotification(dataId, {
      channel: "in_app",
      recipient: dataId,
      subject: `Portal message from ${contact.full_name}`,
      body: check.body.slice(0, 300),
      data: { kind: "portal.message_received", category: "customers", contactId, href: "/messaging" },
    });
  } catch (err) {
    console.error("[portal-messages] notify failed:", err);
  }
  return row;
}

/** Staff → customer. Emails the contact a "new message" notice with a fresh portal link (transactional). */
export async function replyToContact(dataId: string, contactId: string, rawBody: unknown, authorMemberId: string | null): Promise<PortalMessageRow> {
  const check = validateMessageBody(rawBody);
  if (!check.ok) throw new PortalMessageError(check.error, 400);
  const contact = await queryOne<{ full_name: string; email: string | null }>(`SELECT full_name, email FROM crm_contacts WHERE user_id = $1 AND id = $2`, [dataId, contactId]);
  if (!contact) throw new PortalMessageError("not_found", 404);
  const id = randomUUID();
  await query(`INSERT INTO portal_messages (id, user_id, contact_id, direction, body, author_member_id) VALUES ($1, $2, $3, 'out', $4, $5)`, [id, dataId, contactId, check.body, authorMemberId]);
  if (contact.email) {
    try {
      const org = await queryOne<{ name: string }>(`SELECT name FROM organizations WHERE owner_user_id = $1`, [dataId]);
      const link = await issueShareToken(dataId, "portal", contactId, 14);
      await enqueueNotification(dataId, {
        channel: "email",
        recipient: contact.email,
        subject: `New message from ${org?.name ?? "us"}`,
        body: `Hi ${contact.full_name},\n\nYou have a new message in your portal. Open it here:\n${appOrigin()}/p/c/${link.token}\n\n(Service message — you cannot reply to this email.)`,
        data: { kind: "portal.message_out", category: "customers", transactional: true, contactId },
      });
    } catch (err) {
      console.error("[portal-messages] reply email failed:", err);
    }
  }
  return (await queryOne<PortalMessageRow>(`SELECT ${COLS} FROM portal_messages WHERE id = $1`, [id])) as PortalMessageRow;
}

export interface PortalThreadSummary {
  contact_id: string;
  contact_name: string;
  last_body: string;
  last_direction: "in" | "out";
  last_at: string;
  unread: number;
}

/** Staff inbox: one row per contact with portal messages, unread-first. */
export async function listThreads(dataId: string, limit = 50): Promise<PortalThreadSummary[]> {
  if (!(await tableExists("portal_messages"))) return [];
  const rows = await query<{ contact_id: string; contact_name: string | null; last_body: string; last_direction: "in" | "out"; last_at: string; unread: string }>(
    `SELECT m.contact_id, c.full_name AS contact_name, m.body AS last_body, m.direction AS last_direction, m.created_at AS last_at,
            (SELECT COUNT(*) FROM portal_messages u WHERE u.user_id = m.user_id AND u.contact_id = m.contact_id AND u.direction = 'in' AND u.read_at IS NULL)::text AS unread
       FROM portal_messages m
       LEFT JOIN crm_contacts c ON c.id = m.contact_id AND c.user_id = m.user_id
      WHERE m.user_id = $1
        AND m.created_at = (SELECT MAX(x.created_at) FROM portal_messages x WHERE x.user_id = m.user_id AND x.contact_id = m.contact_id)
      ORDER BY m.created_at DESC LIMIT $2`,
    [dataId, Math.min(Math.max(limit, 1), 200)]
  );
  const out = rows.map((r) => ({ contact_id: r.contact_id, contact_name: r.contact_name ?? "Unknown contact", last_body: r.last_body.slice(0, 200), last_direction: r.last_direction, last_at: new Date(r.last_at).toISOString(), unread: Number(r.unread) }));
  return out.sort((a, b) => (a.unread > 0 ? 0 : 1) - (b.unread > 0 ? 0 : 1) || b.last_at.localeCompare(a.last_at));
}

/** Newest-first keyset page (API v1). */
export async function listMessagesPage(dataId: string, opts: { contactId?: string | null; cursor?: Cursor | null; limit?: number } = {}): Promise<PortalMessageRow[]> {
  if (!(await tableExists("portal_messages"))) return [];
  const params: unknown[] = [dataId];
  let sql = `SELECT ${COLS} FROM portal_messages WHERE user_id = $1`;
  if (opts.contactId) {
    params.push(opts.contactId);
    sql += ` AND contact_id = $${params.length}`;
  }
  sql += keysetClause(opts.cursor, params);
  params.push(Math.min(Math.max(opts.limit ?? 50, 1), 201));
  return query<PortalMessageRow>(`${sql} ORDER BY ${keysetOrder()} LIMIT $${params.length}`, params);
}
