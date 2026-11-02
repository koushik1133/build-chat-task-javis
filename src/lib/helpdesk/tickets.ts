import { randomUUID } from "crypto";
import { query, queryOne, withRetry } from "@/lib/dsql";
import { emitEvent } from "@/lib/events/bus";
import { enqueueNotification } from "@/lib/notifications/outbox";
import { keysetClause, keysetOrder, type Cursor } from "@/lib/public-api/pagination";
import {
  computeDueTimes,
  isTicketPriority,
  isTicketSource,
  isTicketStatus,
  type SlaPolicyLike,
  type TicketPriority,
  type TicketSource,
  type TicketStatus,
} from "./sla";

/**
 * Helpdesk data layer. Every function takes `dataId` (the org's owner user id
 * from `requireScope().dataId`) and scopes every query by it.
 *
 * Ticket numbers come from `ticket_counters` with a conditional UPDATE and
 * `withRetry`, the same race-safe pattern as src/lib/docs/numbering.ts.
 */

export interface SlaPolicyRow {
  id: string;
  user_id: string;
  name: string;
  first_response_minutes: number;
  resolution_minutes: number;
  business_hours_only: boolean;
  priority_overrides: string | null;
  is_default: boolean;
  created_at: string;
}

export interface TicketRow {
  id: string;
  user_id: string;
  number: number;
  subject: string;
  status: TicketStatus;
  priority: TicketPriority;
  source: TicketSource;
  contact_id: string | null;
  requester_email: string | null;
  requester_name: string | null;
  assigned_to: string | null;
  sla_policy_id: string | null;
  first_response_due_at: string | null;
  resolution_due_at: string | null;
  first_responded_at: string | null;
  resolved_at: string | null;
  breached_first_response: boolean;
  breached_resolution: boolean;
  escalated_at: string | null;
  tags: string;
  conversation_id: string | null;
  created_at: string;
  updated_at: string;
}

export type AuthorKind = "agent" | "customer" | "ai" | "system";

export interface TicketMessageRow {
  id: string;
  user_id: string;
  ticket_id: string;
  author_kind: AuthorKind;
  author_id: string | null;
  body: string;
  is_internal: boolean;
  created_at: string;
}

export const TICKET_COLS = `id, user_id, number, subject, status, priority, source, contact_id, requester_email, requester_name,
  assigned_to, sla_policy_id, first_response_due_at, resolution_due_at, first_responded_at, resolved_at,
  breached_first_response, breached_resolution, escalated_at, tags, conversation_id, created_at, updated_at`;

const POLICY_COLS = `id, user_id, name, first_response_minutes, resolution_minutes, business_hours_only, priority_overrides, is_default, created_at`;
const MESSAGE_COLS = `id, user_id, ticket_id, author_kind, author_id, body, is_internal, created_at`;

export function parseTags(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((t): t is string => typeof t === "string").slice(0, 50) : [];
  } catch {
    return [];
  }
}

export function formatTicketNumber(n: number): string {
  return `#${String(n).padStart(4, "0")}`;
}

/* ───────────────────────── numbering ───────────────────────── */

class CounterRace extends Error {
  code = "40001";
  constructor() {
    super("ticket counter race (OC000)");
  }
}

export async function nextTicketNumber(dataId: string): Promise<number> {
  return withRetry(async () => {
    const row = await queryOne<{ next_number: number | string }>(
      `SELECT next_number FROM ticket_counters WHERE user_id = $1`,
      [dataId]
    );
    if (!row) {
      const inserted = await query<{ user_id: string }>(
        `INSERT INTO ticket_counters (user_id, next_number) VALUES ($1, 2)
         ON CONFLICT (user_id) DO NOTHING RETURNING user_id`,
        [dataId]
      );
      if (inserted.length === 0) throw new CounterRace();
      return 1;
    }
    const old = Number(row.next_number);
    const updated = await query<{ user_id: string }>(
      `UPDATE ticket_counters SET next_number = $2 WHERE user_id = $1 AND next_number = $3 RETURNING user_id`,
      [dataId, old + 1, old]
    );
    if (updated.length === 0) throw new CounterRace();
    return old;
  }, 6);
}

/* ───────────────────────── SLA policies ───────────────────────── */

export async function listPolicies(dataId: string): Promise<SlaPolicyRow[]> {
  return query<SlaPolicyRow>(
    `SELECT ${POLICY_COLS} FROM sla_policies WHERE user_id = $1 ORDER BY is_default DESC, created_at ASC`,
    [dataId]
  );
}

export async function getPolicy(dataId: string, id: string): Promise<SlaPolicyRow | null> {
  return queryOne<SlaPolicyRow>(`SELECT ${POLICY_COLS} FROM sla_policies WHERE user_id = $1 AND id = $2`, [dataId, id]);
}

export async function getDefaultPolicy(dataId: string): Promise<SlaPolicyRow | null> {
  return queryOne<SlaPolicyRow>(
    `SELECT ${POLICY_COLS} FROM sla_policies WHERE user_id = $1 ORDER BY is_default DESC, created_at ASC LIMIT 1`,
    [dataId]
  );
}

export interface PolicyInput {
  name: string;
  first_response_minutes?: number;
  resolution_minutes?: number;
  business_hours_only?: boolean;
  priority_overrides?: Record<string, unknown> | null;
  is_default?: boolean;
}

export async function createPolicy(dataId: string, input: PolicyInput): Promise<SlaPolicyRow> {
  const id = randomUUID();
  const existing = await query<{ id: string }>(`SELECT id FROM sla_policies WHERE user_id = $1 LIMIT 1`, [dataId]);
  const isDefault = input.is_default ?? existing.length === 0;
  if (isDefault) await query(`UPDATE sla_policies SET is_default = FALSE WHERE user_id = $1`, [dataId]);
  await query(
    `INSERT INTO sla_policies (id, user_id, name, first_response_minutes, resolution_minutes, business_hours_only, priority_overrides, is_default)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      id,
      dataId,
      input.name.trim(),
      input.first_response_minutes ?? 60,
      input.resolution_minutes ?? 1440,
      input.business_hours_only ?? false,
      input.priority_overrides ? JSON.stringify(input.priority_overrides) : null,
      isDefault,
    ]
  );
  const row = await getPolicy(dataId, id);
  if (!row) throw new Error("policy not found after insert");
  return row;
}

export async function updatePolicy(dataId: string, id: string, patch: Partial<PolicyInput>): Promise<SlaPolicyRow> {
  const current = await getPolicy(dataId, id);
  if (!current) throw new Error("SLA policy not found");
  if (patch.is_default) await query(`UPDATE sla_policies SET is_default = FALSE WHERE user_id = $1 AND id <> $2`, [dataId, id]);
  await query(
    `UPDATE sla_policies SET name = $3, first_response_minutes = $4, resolution_minutes = $5, business_hours_only = $6,
        priority_overrides = $7, is_default = $8
     WHERE user_id = $1 AND id = $2`,
    [
      dataId,
      id,
      (patch.name ?? current.name).trim(),
      patch.first_response_minutes ?? current.first_response_minutes,
      patch.resolution_minutes ?? current.resolution_minutes,
      patch.business_hours_only ?? current.business_hours_only,
      patch.priority_overrides === undefined
        ? current.priority_overrides
        : patch.priority_overrides
          ? JSON.stringify(patch.priority_overrides)
          : null,
      patch.is_default ?? current.is_default,
    ]
  );
  const row = await getPolicy(dataId, id);
  if (!row) throw new Error("SLA policy not found");
  return row;
}

export async function deletePolicy(dataId: string, id: string): Promise<void> {
  await query(`UPDATE tickets SET sla_policy_id = NULL WHERE user_id = $1 AND sla_policy_id = $2`, [dataId, id]);
  await query(`DELETE FROM sla_policies WHERE user_id = $1 AND id = $2`, [dataId, id]);
}

/* ───────────────────────── tickets ───────────────────────── */

export interface CreateTicketInput {
  subject: string;
  /** Initial message body (stored as the first customer/agent message). */
  body?: string | null;
  priority?: TicketPriority;
  source?: TicketSource;
  contact_id?: string | null;
  requester_email?: string | null;
  requester_name?: string | null;
  assigned_to?: string | null;
  sla_policy_id?: string | null;
  tags?: string[];
  conversation_id?: string | null;
  /** Who wrote the initial message. Defaults to "customer" for portal/widget/email/sms/whatsapp, "agent" otherwise. */
  author_kind?: AuthorKind;
  author_id?: string | null;
}

function defaultAuthorKind(source: TicketSource): AuthorKind {
  return source === "manual" ? "agent" : source === "agent" ? "ai" : "customer";
}

export async function createTicket(dataId: string, input: CreateTicketInput): Promise<TicketRow> {
  const subject = input.subject.trim().slice(0, 300);
  if (!subject) throw new Error("subject is required");
  const priority: TicketPriority = isTicketPriority(input.priority) ? input.priority : "normal";
  const source: TicketSource = isTicketSource(input.source) ? input.source : "manual";

  const policy = input.sla_policy_id ? await getPolicy(dataId, input.sla_policy_id) : await getDefaultPolicy(dataId);
  const createdAt = new Date();
  const due = policy ? computeDueTimes(policy, priority, createdAt) : null;

  const id = randomUUID();
  const number = await nextTicketNumber(dataId);
  await query(
    `INSERT INTO tickets (id, user_id, number, subject, status, priority, source, contact_id, requester_email, requester_name,
        assigned_to, sla_policy_id, first_response_due_at, resolution_due_at, tags, conversation_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'open', $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $16)`,
    [
      id,
      dataId,
      number,
      subject,
      priority,
      source,
      input.contact_id ?? null,
      input.requester_email?.trim().toLowerCase().slice(0, 200) || null,
      input.requester_name?.trim().slice(0, 200) || null,
      input.assigned_to ?? null,
      policy?.id ?? null,
      due?.firstResponseDueAt.toISOString() ?? null,
      due?.resolutionDueAt.toISOString() ?? null,
      JSON.stringify((input.tags ?? []).map((t) => t.trim()).filter(Boolean).slice(0, 50)),
      input.conversation_id ?? null,
      createdAt.toISOString(),
    ]
  );

  const body = input.body?.trim();
  if (body) {
    const kind = input.author_kind ?? defaultAuthorKind(source);
    await query(
      `INSERT INTO ticket_messages (id, user_id, ticket_id, author_kind, author_id, body, is_internal) VALUES ($1, $2, $3, $4, $5, $6, FALSE)`,
      [randomUUID(), dataId, id, kind, input.author_id ?? null, body.slice(0, 20_000)]
    );
  }

  const row = await getTicketRow(dataId, id);
  if (!row) throw new Error("ticket not found after insert");

  void emitEvent(dataId, {
    type: "ticket.created",
    entity: "ticket",
    entityId: id,
    data: { number, subject, priority, source, requester_email: row.requester_email },
  });
  return row;
}

export async function getTicketRow(dataId: string, id: string): Promise<TicketRow | null> {
  return queryOne<TicketRow>(`SELECT ${TICKET_COLS} FROM tickets WHERE user_id = $1 AND id = $2`, [dataId, id]);
}

export async function listMessages(dataId: string, ticketId: string, opts: { includeInternal?: boolean } = {}): Promise<TicketMessageRow[]> {
  const internal = opts.includeInternal ?? true;
  return query<TicketMessageRow>(
    `SELECT ${MESSAGE_COLS} FROM ticket_messages WHERE user_id = $1 AND ticket_id = $2 ${internal ? "" : "AND is_internal = FALSE"}
     ORDER BY created_at ASC LIMIT 500`,
    [dataId, ticketId]
  );
}

export interface TicketDetail extends TicketRow {
  messages: TicketMessageRow[];
}

export async function getTicket(dataId: string, id: string, opts: { includeInternal?: boolean } = {}): Promise<TicketDetail | null> {
  const row = await getTicketRow(dataId, id);
  if (!row) return null;
  const messages = await listMessages(dataId, id, opts);
  return { ...row, messages };
}

export interface ListTicketsOptions {
  status?: string | null;
  q?: string | null;
  contact_id?: string | null;
  priority?: string | null;
  limit?: number;
  /** "priority" (default: open/urgent first) or "created" (newest first, cursor-friendly). */
  order?: "priority" | "created";
  cursor?: Cursor | null;
}

export async function listTickets(dataId: string, opts: ListTicketsOptions = {}): Promise<TicketRow[]> {
  const where: string[] = ["user_id = $1"];
  const params: unknown[] = [dataId];
  if (opts.status && opts.status !== "all") {
    if (opts.status === "active") {
      where.push(`status IN ('open', 'pending')`);
    } else if (isTicketStatus(opts.status)) {
      params.push(opts.status);
      where.push(`status = $${params.length}`);
    }
  }
  if (opts.priority && isTicketPriority(opts.priority)) {
    params.push(opts.priority);
    where.push(`priority = $${params.length}`);
  }
  if (opts.contact_id) {
    params.push(opts.contact_id);
    where.push(`contact_id = $${params.length}`);
  }
  const q = opts.q?.trim().slice(0, 200);
  if (q) {
    params.push(`%${q.replace(/[%_\\]/g, "\\$&")}%`);
    const idx = params.length;
    where.push(`(subject ILIKE $${idx} OR requester_email ILIKE $${idx} OR requester_name ILIKE $${idx} OR number::text = $${idx + 1})`);
    params.push(q.replace(/^#/, ""));
  }
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  if (opts.order === "created") {
    const keyset = keysetClause(opts.cursor, params);
    params.push(limit);
    return query<TicketRow>(
      `SELECT ${TICKET_COLS} FROM tickets WHERE ${where.join(" AND ")}${keyset} ORDER BY ${keysetOrder()} LIMIT $${params.length}`,
      params
    );
  }
  params.push(limit);
  return query<TicketRow>(
    `SELECT ${TICKET_COLS} FROM tickets WHERE ${where.join(" AND ")}
     ORDER BY CASE status WHEN 'open' THEN 0 WHEN 'pending' THEN 1 WHEN 'resolved' THEN 2 ELSE 3 END,
              CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
              updated_at DESC
     LIMIT $${params.length}`,
    params
  );
}

export interface AddMessageInput {
  author_kind: AuthorKind;
  author_id?: string | null;
  body: string;
  is_internal?: boolean;
}

/**
 * Append a message. Side effects:
 *   - a customer message re-opens a pending ticket;
 *   - the first public agent/ai reply stamps `first_responded_at` and moves open → pending.
 */
export async function addMessage(dataId: string, ticketId: string, input: AddMessageInput): Promise<{ message: TicketMessageRow; ticket: TicketRow }> {
  const ticket = await getTicketRow(dataId, ticketId);
  if (!ticket) throw new Error("Ticket not found");
  const body = input.body.trim().slice(0, 20_000);
  if (!body) throw new Error("body is required");
  const isInternal = input.author_kind === "customer" ? false : Boolean(input.is_internal);

  const id = randomUUID();
  await query(
    `INSERT INTO ticket_messages (id, user_id, ticket_id, author_kind, author_id, body, is_internal) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, dataId, ticketId, input.author_kind, input.author_id ?? null, body, isInternal]
  );

  // Transitions are expressed against the row's current values (not the copy
  // read above) so two concurrent replies cannot re-stamp first_responded_at
  // or re-open a ticket that was just resolved.
  const sets: string[] = ["updated_at = NOW()"];
  if (input.author_kind === "customer") {
    sets.push(`status = CASE WHEN status = 'pending' THEN 'open' ELSE status END`);
  }
  const publicStaffReply = (input.author_kind === "agent" || input.author_kind === "ai") && !isInternal;
  if (publicStaffReply) {
    sets.push(`first_responded_at = COALESCE(first_responded_at, NOW())`);
    sets.push(`status = CASE WHEN status = 'open' THEN 'pending' ELSE status END`);
  }
  await query(`UPDATE tickets SET ${sets.join(", ")} WHERE user_id = $1 AND id = $2`, [dataId, ticketId]);

  const message = await queryOne<TicketMessageRow>(`SELECT ${MESSAGE_COLS} FROM ticket_messages WHERE id = $1`, [id]);
  const updated = await getTicketRow(dataId, ticketId);
  if (!message || !updated) throw new Error("message not found after insert");
  if (!isInternal) {
    void emitEvent(dataId, {
      type: "ticket.replied",
      entity: "ticket",
      entityId: ticketId,
      data: { number: updated.number, author_kind: input.author_kind, status: updated.status, message_id: id },
    });
  }
  return { message, ticket: updated };
}

export async function setStatus(dataId: string, ticketId: string, status: TicketStatus, opts: { actorId?: string | null } = {}): Promise<TicketRow> {
  if (!isTicketStatus(status)) throw new Error("invalid status");
  const ticket = await getTicketRow(dataId, ticketId);
  if (!ticket) throw new Error("Ticket not found");
  const resolving = (status === "resolved" || status === "closed") && !ticket.resolved_at;
  const reopening = (status === "open" || status === "pending") && ticket.resolved_at;
  await query(
    `UPDATE tickets SET status = $3, updated_at = NOW(),
        resolved_at = CASE WHEN $4 THEN NOW() WHEN $5 THEN NULL ELSE resolved_at END
     WHERE user_id = $1 AND id = $2`,
    [dataId, ticketId, status, resolving, Boolean(reopening)]
  );
  if (resolving) {
    await query(
      `INSERT INTO ticket_messages (id, user_id, ticket_id, author_kind, author_id, body, is_internal) VALUES ($1, $2, $3, 'system', $4, $5, TRUE)`,
      [randomUUID(), dataId, ticketId, opts.actorId ?? null, `Ticket marked ${status}.`]
    );
    void emitEvent(dataId, {
      type: "ticket.resolved",
      entity: "ticket",
      entityId: ticketId,
      data: { number: ticket.number, subject: ticket.subject, status },
    });
  }
  const updated = await getTicketRow(dataId, ticketId);
  if (!updated) throw new Error("Ticket not found");
  return updated;
}

export interface UpdateTicketInput {
  subject?: string;
  priority?: TicketPriority;
  assigned_to?: string | null;
  sla_policy_id?: string | null;
  tags?: string[];
  contact_id?: string | null;
  requester_email?: string | null;
  requester_name?: string | null;
  status?: TicketStatus;
}

/** Field updates. A priority or policy change recomputes due times from created_at. */
export async function updateTicket(dataId: string, ticketId: string, patch: UpdateTicketInput, opts: { actorId?: string | null } = {}): Promise<TicketRow> {
  const ticket = await getTicketRow(dataId, ticketId);
  if (!ticket) throw new Error("Ticket not found");

  const priority = patch.priority && isTicketPriority(patch.priority) ? patch.priority : ticket.priority;
  const policyId = patch.sla_policy_id === undefined ? ticket.sla_policy_id : patch.sla_policy_id;
  let firstDue = ticket.first_response_due_at;
  let resDue = ticket.resolution_due_at;
  if (priority !== ticket.priority || policyId !== ticket.sla_policy_id) {
    const policy = policyId ? await getPolicy(dataId, policyId) : null;
    if (policy) {
      const due = computeDueTimes(policy as SlaPolicyLike, priority, ticket.created_at);
      firstDue = due.firstResponseDueAt.toISOString();
      resDue = due.resolutionDueAt.toISOString();
    } else {
      firstDue = null;
      resDue = null;
    }
  }

  await query(
    `UPDATE tickets SET subject = $3, priority = $4, assigned_to = $5, sla_policy_id = $6, tags = $7, contact_id = $8,
        requester_email = $9, requester_name = $10, first_response_due_at = $11, resolution_due_at = $12, updated_at = NOW()
     WHERE user_id = $1 AND id = $2`,
    [
      dataId,
      ticketId,
      (patch.subject ?? ticket.subject).trim().slice(0, 300) || ticket.subject,
      priority,
      patch.assigned_to === undefined ? ticket.assigned_to : patch.assigned_to,
      policyId,
      patch.tags ? JSON.stringify(patch.tags.map((t) => t.trim()).filter(Boolean).slice(0, 50)) : ticket.tags,
      patch.contact_id === undefined ? ticket.contact_id : patch.contact_id,
      patch.requester_email === undefined ? ticket.requester_email : patch.requester_email?.trim().toLowerCase() || null,
      patch.requester_name === undefined ? ticket.requester_name : patch.requester_name?.trim() || null,
      firstDue,
      resDue,
    ]
  );
  if (patch.status && patch.status !== ticket.status) {
    return setStatus(dataId, ticketId, patch.status, opts);
  }
  const updated = await getTicketRow(dataId, ticketId);
  if (!updated) throw new Error("Ticket not found");
  return updated;
}

/* ───────────────────────── SLA sweep ───────────────────────── */

export interface SlaSweepResult {
  scanned: number;
  breachedFirstResponse: number;
  breachedResolution: number;
  escalated: number;
}

/**
 * Cron entry point. Finds active tickets whose due times have passed, flips
 * the breach flags, escalates once (in-app notification + `ticket.sla_breached`
 * event) and returns counts. Idempotent: already-flagged rows are skipped.
 */
export async function runSlaSweep(limit = 200): Promise<SlaSweepResult> {
  const rows = await query<TicketRow>(
    `SELECT ${TICKET_COLS} FROM tickets
     WHERE status IN ('open', 'pending')
       AND (
         (first_response_due_at IS NOT NULL AND first_response_due_at < NOW() AND first_responded_at IS NULL AND breached_first_response = FALSE)
         OR (resolution_due_at IS NOT NULL AND resolution_due_at < NOW() AND breached_resolution = FALSE)
       )
     ORDER BY resolution_due_at ASC NULLS LAST
     LIMIT $1`,
    [Math.min(Math.max(limit, 1), 1000)]
  );

  const result: SlaSweepResult = { scanned: rows.length, breachedFirstResponse: 0, breachedResolution: 0, escalated: 0 };
  const now = Date.now();

  for (const t of rows) {
    const firstBreach =
      !t.breached_first_response && !t.first_responded_at && !!t.first_response_due_at && new Date(t.first_response_due_at).getTime() < now;
    const resBreach = !t.breached_resolution && !!t.resolution_due_at && new Date(t.resolution_due_at).getTime() < now;
    if (!firstBreach && !resBreach) continue;

    // Conditional UPDATEs: a concurrent sweep that already flagged / escalated
    // this ticket makes ours a no-op, so breaches are counted and escalation
    // notifications are sent exactly once.
    let escalate = false;
    try {
      const flagged = await query<{ id: string }>(
        `UPDATE tickets SET
            breached_first_response = breached_first_response OR $3,
            breached_resolution = breached_resolution OR $4,
            updated_at = NOW()
         WHERE user_id = $1 AND id = $2 AND status IN ('open', 'pending')
           AND (($3 AND breached_first_response = FALSE) OR ($4 AND breached_resolution = FALSE))
         RETURNING id`,
        [t.user_id, t.id, firstBreach, resBreach]
      );
      if (flagged.length === 0) continue;
      if (!t.escalated_at) {
        const esc = await query<{ id: string }>(
          `UPDATE tickets SET escalated_at = NOW() WHERE user_id = $1 AND id = $2 AND escalated_at IS NULL RETURNING id`,
          [t.user_id, t.id]
        );
        escalate = esc.length > 0;
      }
    } catch (err) {
      console.error(`[sla] failed to flag ticket ${t.id}:`, err);
      continue;
    }
    if (firstBreach) result.breachedFirstResponse++;
    if (resBreach) result.breachedResolution++;

    const kind = firstBreach && resBreach ? "first response and resolution" : firstBreach ? "first response" : "resolution";
    const label = `${formatTicketNumber(t.number)} ${t.subject}`;

    if (escalate) {
      result.escalated++;
      try {
        await enqueueNotification(t.user_id, {
          channel: "in_app",
          recipient: t.user_id,
          subject: `SLA breached: ${label}`,
          body: `The ${kind} SLA on ticket ${label} (${t.priority}) has been missed. It has been escalated.`,
          data: { ticketId: t.id, kind: "ticket.sla_breached", href: `/helpdesk?ticket=${t.id}` },
        });
      } catch (err) {
        console.error(`[sla] notification enqueue failed for ${t.id}:`, err);
      }
      await query(
        `INSERT INTO ticket_messages (id, user_id, ticket_id, author_kind, author_id, body, is_internal) VALUES ($1, $2, $3, 'system', NULL, $4, TRUE)`,
        [randomUUID(), t.user_id, t.id, `SLA breached (${kind}). Ticket escalated.`]
      ).catch(() => undefined);
    }

    void emitEvent(t.user_id, {
      type: "ticket.sla_breached",
      entity: "ticket",
      entityId: t.id,
      data: { number: t.number, subject: t.subject, priority: t.priority, breached: kind, escalated: escalate },
    });
  }
  return result;
}
