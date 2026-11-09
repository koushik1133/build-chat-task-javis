import { randomUUID } from "crypto";
import { query, queryOne } from "@/lib/dsql";
import { tableExists } from "@/lib/table-exists";
import { tombstoneHash } from "./anonymize";
import {
  CHANNEL_PURPOSE,
  type ConsentPurpose,
  type ConsentSource,
  type ConsentStatus,
  type ConsentSubjectKind,
  type MarketingChannel,
} from "./constants";

/**
 * Consent ledger. Append-only: `recordConsent` inserts, never updates. The
 * current state of a (subject, purpose) is the most recent row.
 *
 * Gate every outbound marketing path with `canSendMarketing()`; it combines
 * the ledger, the do-not-call list and erasure tombstones and fails closed.
 */

export interface ConsentSubject {
  kind: ConsentSubjectKind;
  id: string;
}

export interface ConsentRow {
  id: string;
  user_id: string;
  subject_kind: ConsentSubjectKind;
  subject_id: string;
  purpose: ConsentPurpose;
  status: ConsentStatus;
  source: ConsentSource;
  evidence: string | null;
  occurred_at: string;
  created_at: string;
}

export interface ConsentEvidence {
  ip?: string | null;
  ua?: string | null;
  text_version?: string | null;
  notice_version?: number | null;
  text?: string | null;
  actor?: string | null;
}

const COLS = `id, user_id, subject_kind, subject_id, purpose, status, source, evidence, occurred_at, created_at`;

export async function recordConsent(
  dataId: string,
  subject: ConsentSubject,
  purpose: ConsentPurpose,
  status: ConsentStatus,
  source: ConsentSource,
  evidence: ConsentEvidence = {}
): Promise<ConsentRow> {
  const row = await queryOne<ConsentRow>(
    `INSERT INTO consent_records (id, user_id, subject_kind, subject_id, purpose, status, source, evidence, occurred_at, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW()) RETURNING ${COLS}`,
    [randomUUID(), dataId, subject.kind, subject.id, purpose, status, source, JSON.stringify({ ...evidence, ua: evidence.ua?.slice(0, 500) ?? null })]
  );
  if (!row) throw new Error("consent insert returned no row");
  return row;
}

export async function withdraw(dataId: string, subject: ConsentSubject, purpose: ConsentPurpose, source: ConsentSource, evidence: ConsentEvidence = {}): Promise<ConsentRow> {
  return recordConsent(dataId, subject, purpose, "withdrawn", source, evidence);
}

/** Current status per purpose (latest row wins). */
export async function currentConsent(dataId: string, subject: ConsentSubject): Promise<Partial<Record<ConsentPurpose, { status: ConsentStatus; at: string; source: ConsentSource }>>> {
  const rows = await query<ConsentRow>(
    `SELECT ${COLS} FROM consent_records WHERE user_id = $1 AND subject_kind = $2 AND subject_id = $3 ORDER BY occurred_at DESC, created_at DESC LIMIT 500`,
    [dataId, subject.kind, subject.id]
  ).catch(() => []);
  const out: Partial<Record<ConsentPurpose, { status: ConsentStatus; at: string; source: ConsentSource }>> = {};
  for (const r of rows) {
    if (!out[r.purpose]) out[r.purpose] = { status: r.status, at: r.occurred_at, source: r.source };
  }
  return out;
}

export async function hasConsent(dataId: string, subject: ConsentSubject, purpose: ConsentPurpose): Promise<boolean> {
  const row = await queryOne<{ status: ConsentStatus }>(
    `SELECT status FROM consent_records WHERE user_id = $1 AND subject_kind = $2 AND subject_id = $3 AND purpose = $4
      ORDER BY occurred_at DESC, created_at DESC LIMIT 1`,
    [dataId, subject.kind, subject.id, purpose]
  ).catch(() => null);
  return row?.status === "granted";
}

/** Full history for a subject (newest first). */
export async function listForSubject(dataId: string, subject: ConsentSubject, limit = 200): Promise<ConsentRow[]> {
  return query<ConsentRow>(
    `SELECT ${COLS} FROM consent_records WHERE user_id = $1 AND subject_kind = $2 AND subject_id = $3 ORDER BY occurred_at DESC, created_at DESC LIMIT $4`,
    [dataId, subject.kind, subject.id, Math.max(1, Math.min(1000, limit))]
  ).catch(() => []);
}

/** Recent ledger rows for the org (optionally filtered to one subject kind / purpose). */
export async function listRecent(dataId: string, opts: { purpose?: ConsentPurpose | null; subjectIds?: string[] | null; limit?: number } = {}): Promise<ConsentRow[]> {
  const where = ["user_id = $1", "subject_kind <> 'tombstone'"];
  const values: unknown[] = [dataId];
  if (opts.purpose) {
    values.push(opts.purpose);
    where.push(`purpose = $${values.length}`);
  }
  if (opts.subjectIds?.length) {
    values.push(opts.subjectIds.slice(0, 500));
    where.push(`subject_id = ANY($${values.length})`);
  }
  values.push(Math.max(1, Math.min(500, opts.limit ?? 100)));
  return query<ConsentRow>(`SELECT ${COLS} FROM consent_records WHERE ${where.join(" AND ")} ORDER BY occurred_at DESC LIMIT $${values.length}`, values).catch(() => []);
}

/** Subject ids (of `kind`) with a current grant for `purpose` among `ids`. One query. */
export async function grantedSubset(dataId: string, kind: ConsentSubjectKind, ids: string[], purpose: ConsentPurpose): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  if (!(await tableExists("consent_records"))) return new Set();
  const rows = await query<{ subject_id: string; status: ConsentStatus }>(
    `SELECT DISTINCT ON (subject_id) subject_id, status FROM consent_records
      WHERE user_id = $1 AND subject_kind = $2 AND purpose = $3 AND subject_id = ANY($4)
      ORDER BY subject_id, occurred_at DESC, created_at DESC`,
    [dataId, kind, purpose, ids.slice(0, 5000)]
  ).catch(() => []);
  return new Set(rows.filter((r) => r.status === "granted").map((r) => r.subject_id));
}

/* ---------- tombstones ---------- */

/** After erasure: remember sha256(identifier) so a re-import can never be marketed to. */
export async function writeTombstones(dataId: string, hashes: string[], purposes: ConsentPurpose[] = ["marketing_email", "marketing_sms", "marketing_voice"]): Promise<void> {
  for (const h of hashes) {
    for (const p of purposes) {
      await recordConsent(dataId, { kind: "tombstone", id: h }, p, "withdrawn", "manual", { text: "erasure tombstone" }).catch(() => undefined);
    }
  }
}

export async function isTombstoned(dataId: string, identifier: string | null | undefined, purpose: ConsentPurpose): Promise<boolean> {
  if (!identifier) return false;
  // Fails closed: a DB error reads as "tombstoned" so an erased person is never marketed to by accident.
  const row = await queryOne<{ id: string }>(
    `SELECT id FROM consent_records WHERE user_id = $1 AND subject_kind = 'tombstone' AND subject_id = $2 AND purpose = $3 LIMIT 1`,
    [dataId, tombstoneHash(identifier), purpose]
  ).catch(() => ({ id: "error" }));
  return Boolean(row);
}

/* ---------- gate for outbound marketing ---------- */

export interface MarketingDecision {
  allowed: boolean;
  reason: "granted" | "no_consent" | "opted_out" | "tombstoned" | "unknown_contact";
}

/**
 * Automation-executor / dialer hook. Returns `allowed=false` unless the
 * contact has a current grant for the channel, is not on the opt-out list for
 * it and is not an erasure tombstone. Fails closed on any DB error.
 */
export async function canSendMarketing(dataId: string, contactId: string, channel: MarketingChannel): Promise<MarketingDecision> {
  const purpose = CHANNEL_PURPOSE[channel];
  const contact = await queryOne<{ id: string; email: string | null; phone: string | null }>(
    `SELECT id, email, phone FROM crm_contacts WHERE user_id = $1 AND id = $2 AND deleted_at IS NULL`,
    [dataId, contactId]
  ).catch(() => null);
  if (!contact) return { allowed: false, reason: "unknown_contact" };

  const optChannel = channel === "sms" ? ["sms", "all"] : channel === "voice" ? ["voice", "all"] : ["email", "all"];
  let opt: { id: string } | null;
  try {
    opt = await queryOne<{ id: string }>(
      `SELECT id FROM contact_optouts WHERE user_id = $1 AND channel = ANY($2)
          AND (contact_id = $3 OR ($4::text IS NOT NULL AND lower(email) = lower($4)) OR ($5::text IS NOT NULL AND phone = $5)) LIMIT 1`,
      [dataId, optChannel, contactId, contact.email, contact.phone]
    );
  } catch {
    // Fail closed: when the suppression list cannot be read, nothing goes out.
    return { allowed: false, reason: "opted_out" };
  }
  if (opt) return { allowed: false, reason: "opted_out" };

  const identifier = channel === "email" ? contact.email : contact.phone;
  if (await isTombstoned(dataId, identifier, purpose)) return { allowed: false, reason: "tombstoned" };

  const ok = await hasConsent(dataId, { kind: "contact", id: contactId }, purpose);
  return ok ? { allowed: true, reason: "granted" } : { allowed: false, reason: "no_consent" };
}
