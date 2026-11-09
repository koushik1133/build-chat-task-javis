import { createHash, randomInt, randomUUID } from "crypto";
import { query, queryOne } from "@/lib/dsql";
import { recordAudit } from "@/lib/audit";
import { enqueueNotification } from "@/lib/notifications/outbox";
import { revokeShareTokens } from "@/lib/share-tokens";
import { tableExists } from "@/lib/table-exists";
import { anonymizeRow, ERASED_CUSTOMER_LABEL, ERASED_NAME, REDACTED, stripInternalKeys, tombstonesFor } from "./anonymize";
import { computeDueAt, DSR_REMINDER_DAYS, type DsrKind, type DsrStatus, type DsrSubjectKind } from "./constants";
import { listForSubject, writeTombstones } from "./consent";
import { getPrivacySettings } from "./settings";

/**
 * Data subject requests: intake, verification (email OTP, same pattern as
 * quote acceptance), export bundle built from column whitelists, erasure
 * (anonymise-in-place or delete) and due-date reminders for the cron.
 */

export interface DsrRow {
  id: string;
  user_id: string;
  subject_kind: DsrSubjectKind;
  subject_id: string;
  subject_email: string | null;
  kind: DsrKind;
  status: DsrStatus;
  source: string;
  requested_at: string;
  due_at: string;
  verified_at: string | null;
  completed_at: string | null;
  handled_by: string | null;
  notes: string | null;
  otp_expires_at: string | null;
  otp_attempts: number;
  reminded_at: string | null;
  result: string | null;
  created_at: string;
}

/** Fields safe to send to staff UI and the portal (never the OTP hash). */
const COLS = `id, user_id, subject_kind, subject_id, subject_email, kind, status, source, requested_at, due_at, verified_at, completed_at,
  handled_by, notes, otp_expires_at, otp_attempts, reminded_at, result, created_at`;

export const OTP_TTL_MS = 10 * 60_000;
export const OTP_MAX_ATTEMPTS = 5;

export class DsrError extends Error {
  constructor(message: string, public readonly status = 400) {
    super(message);
    this.name = "DsrError";
  }
}

export interface Subject {
  kind: DsrSubjectKind;
  id: string;
}

interface SubjectIdentity {
  name: string | null;
  email: string | null;
  phone: string | null;
}

/** Resolve the display identity of a subject (contact or lead). */
export async function resolveSubject(dataId: string, subject: Subject): Promise<SubjectIdentity | null> {
  if (subject.kind === "contact") {
    const c = await queryOne<{ full_name: string; email: string | null; phone: string | null }>(
      `SELECT full_name, email, phone FROM crm_contacts WHERE user_id = $1 AND id = $2`,
      [dataId, subject.id]
    );
    return c ? { name: c.full_name, email: c.email, phone: c.phone } : null;
  }
  const l = await queryOne<{ data: string }>(`SELECT data FROM site_leads WHERE user_id = $1 AND id::text = $2`, [dataId, subject.id]);
  if (!l) return null;
  const d = parseJson(l.data);
  const pick = (...keys: string[]) => {
    for (const k of keys) {
      const v = d[k];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
    return null;
  };
  return { name: pick("name", "full_name", "fullName"), email: pick("email", "Email"), phone: pick("phone", "mobile", "Phone") };
}

function parseJson(text: string | null | undefined): Record<string, unknown> {
  if (!text) return {};
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/* ---------- intake ---------- */

export interface OpenRequestInput {
  subject: Subject;
  kind: DsrKind;
  source?: "staff" | "portal" | "api" | "agent";
  email?: string | null;
  notes?: string | null;
  /** Portal tokens already authenticate the subject. */
  preVerified?: boolean;
  handledBy?: string | null;
}

export async function openRequest(dataId: string, input: OpenRequestInput): Promise<DsrRow> {
  const identity = await resolveSubject(dataId, input.subject);
  if (!identity) throw new DsrError("Subject not found", 404);
  const settings = await getPrivacySettings(dataId);
  const now = new Date();
  const due = computeDueAt(now, settings.dsr_due_days);
  const email = (input.email ?? identity.email)?.trim().toLowerCase() ?? null;
  const status: DsrStatus = input.preVerified ? "in_progress" : "received";
  const row = await queryOne<DsrRow>(
    `INSERT INTO dsr_requests (id, user_id, subject_kind, subject_id, subject_email, kind, status, source, requested_at, due_at, verified_at, handled_by, notes, otp_attempts, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 0, NOW()) RETURNING ${COLS}`,
    [randomUUID(), dataId, input.subject.kind, input.subject.id, email, input.kind, status, input.source ?? "staff", now.toISOString(), due.toISOString(), input.preVerified ? now.toISOString() : null, input.handledBy ?? null, input.notes ?? null]
  );
  if (!row) throw new Error("dsr insert returned no row");
  await recordAudit({ dataId, userId: input.handledBy ?? null }, { action: "privacy.request.opened", entity: "dsr_request", entityId: row.id, after: { kind: row.kind, subject_kind: row.subject_kind, source: row.source } });
  await enqueueNotification(dataId, {
    channel: "in_app",
    recipient: dataId,
    subject: `New ${row.kind} request from ${identity.name ?? "a data subject"}`,
    body: `A ${row.kind} request was opened via ${row.source}. It is due ${due.toDateString()}.`,
    data: { kind: "dsr_opened", request_id: row.id, href: "/settings/privacy" },
  }).catch(() => undefined);
  return row;
}

/* ---------- verification ---------- */

function hashOtp(requestId: string, otp: string): string {
  return createHash("sha256").update(`${requestId}:${otp}`, "utf8").digest("hex");
}

/** Send a 6-digit code to the subject's email. Moves the request to `verifying`. */
export async function sendVerification(dataId: string, requestId: string): Promise<{ expiresAt: string }> {
  const r = await getRequest(dataId, requestId);
  if (!r) throw new DsrError("Request not found", 404);
  if (!r.subject_email) throw new DsrError("The subject has no email on file; verify manually and mark in progress.");
  if (r.status === "completed" || r.status === "rejected") throw new DsrError("Request is already closed");
  const otp = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const expiresAt = new Date(Date.now() + OTP_TTL_MS).toISOString();
  await query(`UPDATE dsr_requests SET export_token_hash = $2, otp_expires_at = $3, otp_attempts = 0, status = 'verifying' WHERE id = $1 AND user_id = $4`, [requestId, hashOtp(requestId, otp), expiresAt, dataId]);
  await enqueueNotification(dataId, {
    channel: "email",
    recipient: r.subject_email,
    subject: "Your verification code",
    body: `We received a ${r.kind} request about your personal data. Your one-time verification code is: ${otp}\n\nIt expires in 10 minutes. If you did not make this request, ignore this email.`,
    data: { kind: "dsr_otp", request_id: requestId },
  });
  return { expiresAt };
}

/** Check the code the subject gave staff (or typed in). Marks verified + in_progress. */
export async function verifyRequest(dataId: string, requestId: string, code: string, actorId?: string | null): Promise<DsrRow> {
  const row = await queryOne<{ export_token_hash: string | null; otp_expires_at: string | null; otp_attempts: number }>(
    `SELECT export_token_hash, otp_expires_at, otp_attempts FROM dsr_requests WHERE id = $1 AND user_id = $2`,
    [requestId, dataId]
  );
  if (!row) throw new DsrError("Request not found", 404);
  if (!row.export_token_hash) throw new DsrError("Send a verification code first");
  if (row.otp_expires_at && new Date(row.otp_expires_at).getTime() < Date.now()) throw new DsrError("Code expired; send a new one");
  if (Number(row.otp_attempts) >= OTP_MAX_ATTEMPTS) throw new DsrError("Too many attempts; send a new code");
  if (hashOtp(requestId, code.trim()) !== row.export_token_hash) {
    await query(`UPDATE dsr_requests SET otp_attempts = otp_attempts + 1 WHERE id = $1`, [requestId]);
    throw new DsrError("Incorrect code");
  }
  const updated = await queryOne<DsrRow>(
    `UPDATE dsr_requests SET verified_at = NOW(), status = 'in_progress', export_token_hash = NULL, handled_by = COALESCE(handled_by, $3) WHERE id = $1 AND user_id = $2 RETURNING ${COLS}`,
    [requestId, dataId, actorId ?? null]
  );
  if (!updated) throw new DsrError("Request not found", 404);
  await recordAudit({ dataId, userId: actorId ?? null }, { action: "privacy.request.verified", entity: "dsr_request", entityId: requestId });
  return updated;
}

/* ---------- listing / status ---------- */

export async function getRequest(dataId: string, id: string): Promise<DsrRow | null> {
  return queryOne<DsrRow>(`SELECT ${COLS} FROM dsr_requests WHERE id = $1 AND user_id = $2`, [id, dataId]);
}

export async function listRequests(dataId: string, opts: { status?: DsrStatus | "open" | null; subject?: Subject | null; limit?: number } = {}): Promise<DsrRow[]> {
  const where = ["user_id = $1"];
  const values: unknown[] = [dataId];
  if (opts.status === "open") where.push(`status NOT IN ('completed','rejected')`);
  else if (opts.status) {
    values.push(opts.status);
    where.push(`status = $${values.length}`);
  }
  if (opts.subject) {
    values.push(opts.subject.kind, opts.subject.id);
    where.push(`subject_kind = $${values.length - 1}`, `subject_id = $${values.length}`);
  }
  values.push(Math.max(1, Math.min(500, opts.limit ?? 200)));
  return query<DsrRow>(`SELECT ${COLS} FROM dsr_requests WHERE ${where.join(" AND ")} ORDER BY (status IN ('completed','rejected')) ASC, due_at ASC LIMIT $${values.length}`, values).catch(() => []);
}

export interface UpdateRequestInput {
  status?: DsrStatus;
  notes?: string | null;
  handledBy?: string | null;
}

export async function updateRequest(dataId: string, id: string, input: UpdateRequestInput, actorId?: string | null): Promise<DsrRow> {
  const before = await getRequest(dataId, id);
  if (!before) throw new DsrError("Request not found", 404);
  const sets: string[] = [];
  const values: unknown[] = [id, dataId];
  if (input.status) {
    values.push(input.status);
    sets.push(`status = $${values.length}`);
    if (input.status === "completed" || input.status === "rejected") sets.push(`completed_at = NOW()`);
    if (input.status === "in_progress" && !before.verified_at) sets.push(`verified_at = NOW()`); // manual verification
  }
  if (input.notes !== undefined) {
    values.push(input.notes);
    sets.push(`notes = $${values.length}`);
  }
  if (input.handledBy !== undefined) {
    values.push(input.handledBy);
    sets.push(`handled_by = $${values.length}`);
  }
  if (sets.length === 0) return before;
  const row = await queryOne<DsrRow>(`UPDATE dsr_requests SET ${sets.join(", ")} WHERE id = $1 AND user_id = $2 RETURNING ${COLS}`, values);
  if (!row) throw new DsrError("Request not found", 404);
  await recordAudit({ dataId, userId: actorId ?? null }, { action: "privacy.request.updated", entity: "dsr_request", entityId: id, before: { status: before.status, notes: before.notes }, after: { status: row.status, notes: row.notes } });
  return row;
}

/* ---------- export (access / portability) ---------- */

export interface SubjectExport {
  generated_at: string;
  subject: { kind: DsrSubjectKind; id: string; name: string | null; email: string | null; phone: string | null };
  profile: Record<string, unknown> | null;
  bookings: Array<Record<string, unknown>>;
  tickets: Array<Record<string, unknown> & { messages: Array<Record<string, unknown>> }>;
  quotes: Array<Record<string, unknown>>;
  invoices: Array<Record<string, unknown> & { payments: Array<Record<string, unknown>> }>;
  records: Array<Record<string, unknown>>;
  mail_messages: Array<Record<string, unknown>>;
  conversations: Array<Record<string, unknown>>;
  voice_targets: Array<Record<string, unknown>>;
  opt_outs: Array<Record<string, unknown>>;
  consents: Array<Record<string, unknown>>;
  requests: Array<Record<string, unknown>>;
}

/** Column whitelists — never SELECT *; never staff ids. */
const W = {
  contact: "id, full_name, email, phone, company, role, lifecycle, tags, last_contact, created_at, updated_at",
  lead: "id::text AS id, data, status, follow_up_at, sent_at, created_at",
  booking: "id, name, email, phone, starts_at, ends_at, status, source, notes, created_at",
  ticket: "id, number, subject, status, priority, source, requester_email, requester_name, created_at, resolved_at",
  ticketMsg: "id, author_kind, body, created_at",
  quote: "id, number, status, currency, subtotal_minor, tax_minor, total_minor, valid_until, created_at, sent_at, accepted_at",
  invoice: "id, number, status, currency, subtotal_minor, tax_minor, total_minor, paid_minor, due_at, items, created_at, sent_at, paid_at",
  payment: "id, provider, amount_minor, currency, status, created_at",
  record: "id, title, stage, data, amount_minor, currency, due_at, created_at",
  mail: "id, direction, from_addr, to_addrs, subject, snippet, received_at",
  conversation: "id, channel, from_number, messages, created_at, updated_at",
  voice: "id, phone, first_name, status, attempts, last_attempt_at, outcome, created_at",
  optout: "id, channel, reason, created_at",
} as const;

async function safeRows<T extends Record<string, unknown>>(table: string, sql: string, params: unknown[]): Promise<T[]> {
  if (!(await tableExists(table))) return [];
  return query<T>(sql, params).catch(() => []);
}

const expandJson = (rows: Array<Record<string, unknown>>, cols: string[]) =>
  rows.map((r) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(r)) out[k] = v instanceof Date ? v.toISOString() : cols.includes(k) && typeof v === "string" ? safeParse(v) : v;
    return out;
  });
const omit = (row: Record<string, unknown>, key: string): Record<string, unknown> => {
  const out = { ...row };
  delete out[key];
  return out;
};
const safeParse = (s: string): unknown => {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
};

export async function buildSubjectExport(dataId: string, subject: Subject): Promise<SubjectExport> {
  const identity = await resolveSubject(dataId, subject);
  if (!identity) throw new DsrError("Subject not found", 404);
  const email = identity.email?.toLowerCase() ?? null;
  const phone = identity.phone ?? null;
  const contactId = subject.kind === "contact" ? subject.id : null;

  const profile =
    subject.kind === "contact"
      ? expandJson(await safeRows("crm_contacts", `SELECT ${W.contact} FROM crm_contacts WHERE user_id = $1 AND id = $2`, [dataId, subject.id]), ["tags"])[0] ?? null
      : expandJson(await safeRows("site_leads", `SELECT ${W.lead} FROM site_leads WHERE user_id = $1 AND id::text = $2`, [dataId, subject.id]), ["data"])[0] ?? null;

  const byContactOrEmail = (col = "contact_id", emailCol = "email") =>
    `user_id = $1 AND (($2::text IS NOT NULL AND ${col} = $2) OR ($3::text IS NOT NULL AND lower(${emailCol}) = $3))`;

  const [bookings, tickets, quotes, invoices, records, mail, conversations, voice, optouts, consents, requests] = await Promise.all([
    safeRows("bookings", `SELECT ${W.booking} FROM bookings WHERE ${byContactOrEmail()} ORDER BY starts_at DESC LIMIT 500`, [dataId, contactId, email]),
    safeRows<Record<string, unknown> & { id: string }>("tickets", `SELECT ${W.ticket} FROM tickets WHERE ${byContactOrEmail("contact_id", "requester_email")} ORDER BY created_at DESC LIMIT 500`, [dataId, contactId, email]),
    contactId ? safeRows("quotes", `SELECT ${W.quote} FROM quotes WHERE user_id = $1 AND contact_id = $2 ORDER BY created_at DESC LIMIT 500`, [dataId, contactId]) : Promise.resolve([]),
    contactId ? safeRows<Record<string, unknown> & { id: string }>("invoices", `SELECT ${W.invoice} FROM invoices WHERE user_id = $1 AND contact_id = $2 ORDER BY created_at DESC LIMIT 500`, [dataId, contactId]) : Promise.resolve([]),
    contactId ? safeRows("records", `SELECT ${W.record} FROM records WHERE user_id = $1 AND contact_id = $2 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 500`, [dataId, contactId]) : Promise.resolve([]),
    email ? safeRows("mail_messages", `SELECT ${W.mail} FROM mail_messages WHERE user_id = $1 AND (lower(from_addr) = $2 OR lower(to_addrs) LIKE $3) ORDER BY received_at DESC LIMIT 500`, [dataId, email, `%${email.replace(/[%_]/g, "")}%`]) : Promise.resolve([]),
    phone ? safeRows("messaging_conversations", `SELECT ${W.conversation} FROM messaging_conversations WHERE user_id = $1 AND from_number = $2 ORDER BY updated_at DESC LIMIT 100`, [dataId, phone]) : Promise.resolve([]),
    safeRows("voice_campaign_targets", `SELECT ${W.voice} FROM voice_campaign_targets WHERE user_id = $1 AND (($2::text IS NOT NULL AND contact_id = $2) OR ($3::text IS NOT NULL AND phone = $3)) ORDER BY created_at DESC LIMIT 500`, [dataId, contactId, phone]),
    safeRows("contact_optouts", `SELECT ${W.optout} FROM contact_optouts WHERE user_id = $1 AND (($2::text IS NOT NULL AND contact_id = $2) OR ($3::text IS NOT NULL AND lower(email) = $3) OR ($4::text IS NOT NULL AND phone = $4)) LIMIT 200`, [dataId, contactId, email, phone]),
    listForSubject(dataId, subject, 500),
    listRequests(dataId, { subject, limit: 100 }),
  ]);

  const ticketMessages = tickets.length
    ? await safeRows<Record<string, unknown> & { ticket_id: string }>("ticket_messages", `SELECT ticket_id, ${W.ticketMsg} FROM ticket_messages WHERE user_id = $1 AND ticket_id = ANY($2) AND is_internal = FALSE ORDER BY created_at ASC LIMIT 5000`, [dataId, tickets.map((t) => t.id)])
    : [];
  const payments = invoices.length
    ? await safeRows<Record<string, unknown> & { invoice_id: string }>("invoice_payments", `SELECT invoice_id, ${W.payment} FROM invoice_payments WHERE invoice_id = ANY($1) ORDER BY created_at ASC LIMIT 5000`, [invoices.map((i) => i.id)])
    : [];

  const bundle: SubjectExport = {
    generated_at: new Date().toISOString(),
    subject: { kind: subject.kind, id: subject.id, name: identity.name, email: identity.email, phone: identity.phone },
    profile,
    bookings: expandJson(bookings, []),
    tickets: expandJson(tickets, []).map((t) => ({ ...t, messages: expandJson(ticketMessages.filter((m) => m.ticket_id === t.id).map((m) => omit(m, "ticket_id")), []) })),
    quotes: expandJson(quotes, []),
    invoices: expandJson(invoices, ["items"]).map((i) => ({ ...i, payments: expandJson(payments.filter((p) => p.invoice_id === i.id).map((p) => omit(p, "invoice_id")), []) })),
    records: expandJson(records, ["data"]),
    mail_messages: expandJson(mail, ["to_addrs"]),
    conversations: expandJson(conversations, ["messages"]),
    voice_targets: expandJson(voice, ["outcome"]),
    opt_outs: expandJson(optouts, []),
    consents: expandJson(consents.map((c) => ({ purpose: c.purpose, status: c.status, source: c.source, evidence: c.evidence, occurred_at: c.occurred_at })), ["evidence"]),
    requests: requests.map((r) => ({ id: r.id, kind: r.kind, status: r.status, requested_at: r.requested_at, due_at: r.due_at, completed_at: r.completed_at })),
  };
  return stripInternalKeys(bundle);
}

/* ---------- erasure ---------- */

export type EraseMode = "anonymize" | "delete";

export interface EraseResult {
  mode: EraseMode;
  tombstones: number;
  affected: Record<string, number>;
  pinecone: "deleted" | "skipped" | "failed";
}

async function run(table: string, sql: string, params: unknown[]): Promise<number> {
  if (!(await tableExists(table))) return 0;
  const rows = await query<{ id: string }>(`${sql} RETURNING id`, params).catch(() => []);
  return rows.length;
}

/**
 * Erase a subject. Financial rows (quotes, invoices, payments) are kept with
 * amounts intact and the contact label replaced; everything else is anonymised
 * in place or deleted. Opt-outs stay effective through hashed tombstones.
 */
export async function eraseSubject(dataId: string, subject: Subject, opts: { mode: EraseMode; actorId?: string | null; requestId?: string | null }): Promise<EraseResult> {
  const identity = await resolveSubject(dataId, subject);
  if (!identity) throw new DsrError("Subject not found", 404);
  const email = identity.email?.toLowerCase() ?? null;
  const phone = identity.phone ?? null;
  const contactId = subject.kind === "contact" ? subject.id : null;
  const affected: Record<string, number> = {};
  const del = opts.mode === "delete";

  // Tombstones first so an interrupted run still blocks future marketing.
  const hashes = tombstonesFor([email, phone]);
  await writeTombstones(dataId, hashes);

  if (subject.kind === "contact") {
    affected.crm_contacts = del
      ? await run("crm_contacts", `DELETE FROM crm_contacts WHERE user_id = $1 AND id = $2`, [dataId, subject.id])
      : await run("crm_contacts", `UPDATE crm_contacts SET full_name = $3, email = NULL, phone = NULL, company = NULL, role = NULL, notes = NULL, tags = '[]', deleted_at = COALESCE(deleted_at, NOW()), updated_at = NOW() WHERE user_id = $1 AND id = $2`, [dataId, subject.id, ERASED_NAME]);
    affected.crm_activities = await run("crm_activities", `DELETE FROM crm_activities WHERE user_id = $1 AND contact_id = $2`, [dataId, subject.id]);
  } else {
    affected.site_leads = del
      ? await run("site_leads", `DELETE FROM site_leads WHERE user_id = $1 AND id::text = $2`, [dataId, subject.id])
      : await run("site_leads", `UPDATE site_leads SET data = '{}', research_summary = NULL, draft_email_subject = NULL, draft_email_body = NULL WHERE user_id = $1 AND id::text = $2`, [dataId, subject.id]);
  }

  const match = (col = "contact_id", emailCol = "email") => `user_id = $1 AND (($2::text IS NOT NULL AND ${col} = $2) OR ($3::text IS NOT NULL AND lower(${emailCol}) = $3))`;

  affected.bookings = del
    ? await run("bookings", `DELETE FROM bookings WHERE ${match()}`, [dataId, contactId, email])
    : await run("bookings", `UPDATE bookings SET name = $4, email = NULL, phone = NULL, notes = NULL, updated_at = NOW() WHERE ${match()}`, [dataId, contactId, email, ERASED_CUSTOMER_LABEL]);

  const ticketIds = (await query<{ id: string }>(`SELECT id FROM tickets WHERE ${match("contact_id", "requester_email")}`, [dataId, contactId, email]).catch(() => [])).map((t) => t.id);
  if (ticketIds.length) {
    affected.ticket_messages = del
      ? await run("ticket_messages", `DELETE FROM ticket_messages WHERE user_id = $1 AND ticket_id = ANY($2)`, [dataId, ticketIds])
      : await run("ticket_messages", `UPDATE ticket_messages SET body = $3 WHERE user_id = $1 AND ticket_id = ANY($2) AND author_kind = 'customer'`, [dataId, ticketIds, REDACTED]);
    affected.tickets = del
      ? await run("tickets", `DELETE FROM tickets WHERE user_id = $1 AND id = ANY($2)`, [dataId, ticketIds])
      : await run("tickets", `UPDATE tickets SET requester_name = $3, requester_email = NULL, subject = $4, contact_id = NULL, updated_at = NOW() WHERE user_id = $1 AND id = ANY($2)`, [dataId, ticketIds, ERASED_CUSTOMER_LABEL, REDACTED]);
  }

  if (contactId) {
    // Accounting records are retained; only the link + free text goes.
    affected.quotes = await run("quotes", `UPDATE quotes SET notes = NULL, updated_at = NOW() WHERE user_id = $1 AND contact_id = $2`, [dataId, contactId]);
    affected.invoices = await run("invoices", `UPDATE invoices SET notes = NULL, updated_at = NOW() WHERE user_id = $1 AND contact_id = $2`, [dataId, contactId]);
    affected.quote_acceptances = await run("quote_acceptances", `UPDATE quote_acceptances SET accepted_name = $2, accepted_email = NULL, ip = NULL, user_agent = NULL WHERE quote_id IN (SELECT id FROM quotes WHERE user_id = $1 AND contact_id = $3)`, [dataId, ERASED_CUSTOMER_LABEL, contactId]);
    affected.records = del
      ? await run("records", `DELETE FROM records WHERE user_id = $1 AND contact_id = $2`, [dataId, contactId])
      : await run("records", `UPDATE records SET contact_id = NULL, summary = NULL, updated_at = NOW() WHERE user_id = $1 AND contact_id = $2`, [dataId, contactId]);
    affected.voice_campaign_targets = await run("voice_campaign_targets", `UPDATE voice_campaign_targets SET first_name = NULL, status = CASE WHEN status = 'queued' THEN 'opted_out' ELSE status END WHERE user_id = $1 AND contact_id = $2`, [dataId, contactId]);
    await revokeShareTokens("portal", contactId).catch(() => undefined);
    affected.share_tokens = 1;
  }
  if (email) {
    affected.mail_messages = await run("mail_messages", `UPDATE mail_messages SET body_text = NULL, body_html = NULL, snippet = NULL, subject = $3 WHERE user_id = $1 AND (lower(from_addr) = $2 OR lower(to_addrs) LIKE $4)`, [dataId, email, REDACTED, `%${email.replace(/[%_]/g, "")}%`]);
  }
  if (phone) {
    affected.messaging_conversations = del
      ? await run("messaging_conversations", `DELETE FROM messaging_conversations WHERE user_id = $1 AND from_number = $2`, [dataId, phone])
      : await run("messaging_conversations", `UPDATE messaging_conversations SET messages = '[]', updated_at = NOW() WHERE user_id = $1 AND from_number = $2`, [dataId, phone]);
    affected.voice_calls = await run("voice_calls", `UPDATE voice_calls SET recording_url = NULL, transcript = NULL WHERE user_id = $1 AND target_id IN (SELECT id FROM voice_campaign_targets WHERE user_id = $1 AND phone = $2)`, [dataId, phone]);
    affected.voice_targets_phone = await run("voice_campaign_targets", `UPDATE voice_campaign_targets SET first_name = NULL, status = CASE WHEN status = 'queued' THEN 'opted_out' ELSE status END WHERE user_id = $1 AND phone = $2`, [dataId, phone]);
  }
  // Opt-out rows keep working through hashes; the plaintext identifiers go.
  affected.contact_optouts = await run("contact_optouts", `UPDATE contact_optouts SET email = NULL, phone = NULL, reason = COALESCE(reason, '') || ' [erased]' WHERE user_id = $1 AND (($2::text IS NOT NULL AND contact_id = $2) OR ($3::text IS NOT NULL AND lower(email) = $3) OR ($4::text IS NOT NULL AND phone = $4))`, [dataId, contactId, email, phone]);

  // Vector store: any chunks indexed under `contact:<id>` (best effort; no key → skipped).
  let pinecone: EraseResult["pinecone"] = "skipped";
  if (contactId && process.env.PINECONE_API_KEY) {
    try {
      const { deleteFile } = await import("@/lib/pinecone");
      await deleteFile(dataId, `contact:${contactId}`);
      pinecone = "deleted";
    } catch {
      pinecone = "failed";
    }
  }

  const result: EraseResult = { mode: opts.mode, tombstones: hashes.length, affected, pinecone };
  await recordAudit({ dataId, userId: opts.actorId ?? null }, { action: "privacy.subject.erased", entity: subject.kind, entityId: subject.id, after: { mode: opts.mode, affected, request_id: opts.requestId ?? null } });
  if (opts.requestId) {
    await query(`UPDATE dsr_requests SET status = 'completed', completed_at = NOW(), result = $3, handled_by = COALESCE(handled_by, $4) WHERE id = $1 AND user_id = $2`, [opts.requestId, dataId, JSON.stringify(result), opts.actorId ?? null]).catch(() => undefined);
  }
  return result;
}

/** Convenience for tests / callers that already have the rows. */
export { anonymizeRow };

/* ---------- cron: due-soon reminders ---------- */

export async function dueSoon(withinDays = DSR_REMINDER_DAYS, limit = 200): Promise<DsrRow[]> {
  if (!(await tableExists("dsr_requests"))) return [];
  return query<DsrRow>(
    `SELECT ${COLS} FROM dsr_requests
      WHERE status NOT IN ('completed','rejected') AND reminded_at IS NULL AND due_at <= NOW() + ($1 || ' days')::interval
      ORDER BY due_at ASC LIMIT $2`,
    [String(withinDays), Math.max(1, Math.min(1000, limit))]
  ).catch(() => []);
}

/** Cron hook: in-app reminder once per request, 5 days before due (and immediately when already overdue). */
export async function remindDueSoon(limit = 200): Promise<{ reminded: number }> {
  const rows = await dueSoon(DSR_REMINDER_DAYS, limit);
  let reminded = 0;
  for (const r of rows) {
    const overdue = new Date(r.due_at).getTime() < Date.now();
    await enqueueNotification(r.user_id, {
      channel: "in_app",
      recipient: r.user_id,
      subject: overdue ? `Privacy request overdue: ${r.kind}` : `Privacy request due soon: ${r.kind}`,
      body: `${r.kind} request for ${r.subject_email ?? r.subject_kind} is due ${new Date(r.due_at).toDateString()}. Open Settings → Privacy & data.`,
      data: { kind: "dsr_due_soon", request_id: r.id, href: "/settings/privacy" },
    }).catch(() => undefined);
    await query(`UPDATE dsr_requests SET reminded_at = NOW() WHERE id = $1`, [r.id]).catch(() => undefined);
    reminded++;
  }
  return { reminded };
}
