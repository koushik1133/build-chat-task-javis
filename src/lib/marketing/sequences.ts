import { keysetClause, keysetOrder, type Cursor } from "@/lib/public-api/pagination";
import { randomUUID } from "crypto";
import { query, queryOne, withRetry } from "@/lib/dsql";
import { emitEvent } from "@/lib/events/bus";
import { escapeLike } from "@/lib/like";
import { tableExists } from "@/lib/table-exists";
import { getAudience, resolveAudienceIds } from "./audiences";
import { loadContact, sendMarketingMessage, type MarketingContact } from "./send";
import { getTemplate } from "./templates";
import { parseAudienceDefinition, parseSteps, parseTriggerConfig, type EnrollmentStatus, type SequenceStep, type SequenceStatus, type SequenceTrigger, type SequenceTriggerConfig } from "./types";
import { deleteInBatches } from "@/lib/db/batch";

/**
 * Drip sequences. An enrollment walks `steps` one at a time: `next_at` is
 * when the current `step_index` is due. `runDueEnrollments` (cron) claims due
 * rows with a conditional UPDATE, re-checks consent through the shared send
 * path, exits on reply / unsubscribe, and schedules the next step.
 */

export interface SequenceRow {
  id: string;
  user_id: string;
  name: string;
  trigger: SequenceTrigger;
  trigger_config: string;
  steps: string;
  status: SequenceStatus;
  created_at: string;
  updated_at: string;
}

export interface EnrollmentRow {
  id: string;
  user_id: string;
  sequence_id: string;
  contact_id: string;
  step_index: number;
  next_at: string | null;
  status: EnrollmentStatus;
  exited_reason: string | null;
  /** Highest step index whose message was sent; guards against re-sending after a crash before advance. */
  last_step_sent_index?: number | null;
  last_step_sent_at?: string | null;
  created_at: string;
  updated_at: string;
}

const COLS = `id, user_id, name, trigger, trigger_config, steps, status, created_at, updated_at`;
const ENR_COLS = `id, user_id, sequence_id, contact_id, step_index, next_at, status, exited_reason, last_step_sent_index, last_step_sent_at, created_at, updated_at`;

export class SequenceError extends Error {
  constructor(
    message: string,
    readonly code: "not_found" | "invalid" | "paused"
  ) {
    super(message);
    this.name = "SequenceError";
  }
}

export interface SequenceInput {
  name: string;
  trigger: SequenceTrigger;
  trigger_config?: SequenceTriggerConfig | null;
  steps: SequenceStep[];
  status?: SequenceStatus;
}

export async function listSequences(dataId: string, opts: { cursor?: Cursor | null; limit?: number } = {}): Promise<Array<SequenceRow & { active: number; done: number; exited: number; audience_name: string | null }>> {
  const params: unknown[] = [dataId];
  const where = `user_id = $1${keysetClause(opts.cursor, params)}`;
  params.push(Math.min(Math.max(opts.limit ?? 200, 1), 201));
  const rows = await query<SequenceRow>(`SELECT ${COLS} FROM sequences WHERE ${where} ORDER BY ${keysetOrder()} LIMIT $${params.length}`, params);
  if (rows.length === 0) return [];
  const audienceIds = new Set<string>();
  for (const r of rows) {
    const id = parseTriggerConfig(r.trigger_config).audience_id;
    if (id) audienceIds.add(id);
  }
  const names = new Map<string, string>();
  if (audienceIds.size > 0) {
    const auds = await query<{ id: string; name: string }>(`SELECT id, name FROM audiences WHERE user_id = $1 AND id = ANY($2)`, [dataId, [...audienceIds]]).catch(() => []);
    for (const a of auds) names.set(a.id, a.name);
  }
  const counts = await query<{ sequence_id: string; status: EnrollmentStatus; n: string }>(
    `SELECT sequence_id, status, COUNT(*)::text AS n FROM sequence_enrollments WHERE user_id = $1 AND sequence_id = ANY($2) GROUP BY sequence_id, status`,
    [dataId, rows.map((r) => r.id)]
  ).catch(() => []);
  const by = new Map<string, { active: number; done: number; exited: number }>();
  for (const c of counts) {
    const cur = by.get(c.sequence_id) ?? { active: 0, done: 0, exited: 0 };
    cur[c.status] = parseInt(c.n, 10) || 0;
    by.set(c.sequence_id, cur);
  }
  return rows.map((r) => {
    const aid = parseTriggerConfig(r.trigger_config).audience_id;
    return { ...r, ...(by.get(r.id) ?? { active: 0, done: 0, exited: 0 }), audience_name: aid ? names.get(aid) ?? null : null };
  });
}

export async function getSequence(dataId: string, id: string): Promise<SequenceRow | null> {
  return queryOne<SequenceRow>(`SELECT ${COLS} FROM sequences WHERE user_id = $1 AND id = $2`, [dataId, id]);
}

/** Find by id, or by case-insensitive name (used by the `marketing.enroll` tool). */
export async function findSequence(dataId: string, ref: string): Promise<SequenceRow | null> {
  return (await getSequence(dataId, ref)) ?? queryOne<SequenceRow>(`SELECT ${COLS} FROM sequences WHERE user_id = $1 AND lower(name) = lower($2) ORDER BY created_at ASC LIMIT 1`, [dataId, ref.trim()]);
}

export async function createSequence(dataId: string, input: SequenceInput): Promise<SequenceRow> {
  if (input.steps.length === 0) throw new SequenceError("Add at least one step", "invalid");
  const row = await queryOne<SequenceRow>(
    `INSERT INTO sequences (id, user_id, name, trigger, trigger_config, steps, status, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW()) RETURNING ${COLS}`,
    [randomUUID(), dataId, input.name.trim(), input.trigger, JSON.stringify(input.trigger_config ?? {}), JSON.stringify(input.steps), input.status ?? "active"]
  );
  if (!row) throw new Error("sequence insert returned no row");
  return row;
}

export async function updateSequence(dataId: string, id: string, patch: Partial<SequenceInput>): Promise<SequenceRow | null> {
  const cur = await getSequence(dataId, id);
  if (!cur) return null;
  if (patch.steps && patch.steps.length === 0) throw new SequenceError("Add at least one step", "invalid");
  return queryOne<SequenceRow>(
    `UPDATE sequences SET name = $3, trigger = $4, trigger_config = $5, steps = $6, status = $7, updated_at = NOW() WHERE user_id = $1 AND id = $2 RETURNING ${COLS}`,
    [dataId, id, (patch.name ?? cur.name).trim(), patch.trigger ?? cur.trigger, JSON.stringify(patch.trigger_config === undefined ? parseTriggerConfig(cur.trigger_config) : (patch.trigger_config ?? {})), JSON.stringify(patch.steps ?? parseSteps(cur.steps)), patch.status ?? cur.status]
  );
}

export async function deleteSequence(dataId: string, id: string): Promise<boolean> {
  await deleteInBatches("sequence_enrollments", "user_id = $1 AND sequence_id = $2", [dataId, id]);
  const row = await queryOne<{ id: string }>(`DELETE FROM sequences WHERE user_id = $1 AND id = $2 RETURNING id`, [dataId, id]);
  return Boolean(row);
}

/* ---------- enrollment ---------- */

function dueAt(step: SequenceStep | undefined, from = new Date()): Date {
  return new Date(from.getTime() + Math.max(0, step?.delay_hours ?? 0) * 3_600_000);
}

export type EnrollOutcome = { ok: true; enrollment: EnrollmentRow; created: boolean } | { ok: false; reason: "sequence_not_found" | "sequence_paused" | "contact_not_found" | "no_steps" };

/** Idempotent: an existing enrollment (any status) is returned, not duplicated. */
export async function enroll(dataId: string, sequenceId: string, contactId: string, source = "manual"): Promise<EnrollOutcome> {
  const seq = await getSequence(dataId, sequenceId);
  if (!seq) return { ok: false, reason: "sequence_not_found" };
  if (seq.status !== "active") return { ok: false, reason: "sequence_paused" };
  const steps = parseSteps(seq.steps);
  if (steps.length === 0) return { ok: false, reason: "no_steps" };
  const contact = await loadContact(dataId, contactId);
  if (!contact) return { ok: false, reason: "contact_not_found" };
  const existing = await queryOne<EnrollmentRow>(`SELECT ${ENR_COLS} FROM sequence_enrollments WHERE user_id = $1 AND sequence_id = $2 AND contact_id = $3`, [dataId, sequenceId, contactId]);
  if (existing) return { ok: true, enrollment: existing, created: false };
  const row = await queryOne<EnrollmentRow>(
    `INSERT INTO sequence_enrollments (id, user_id, sequence_id, contact_id, step_index, next_at, status, created_at, updated_at) VALUES ($1, $2, $3, $4, 0, $5, 'active', NOW(), NOW()) RETURNING ${ENR_COLS}`,
    [randomUUID(), dataId, sequenceId, contactId, dueAt(steps[0]).toISOString()]
  ).catch(async () => queryOne<EnrollmentRow>(`SELECT ${ENR_COLS} FROM sequence_enrollments WHERE user_id = $1 AND sequence_id = $2 AND contact_id = $3`, [dataId, sequenceId, contactId]));
  if (!row) throw new Error("enrollment insert returned no row");
  await emitEvent(dataId, { type: "sequence.enrolled", entity: "sequence", entityId: sequenceId, data: { contact_id: contactId, enrollment_id: row.id, source } });
  return { ok: true, enrollment: row, created: true };
}

export async function exitEnrollment(dataId: string, enrollmentId: string, reason: string): Promise<EnrollmentRow | null> {
  return queryOne<EnrollmentRow>(
    `UPDATE sequence_enrollments SET status = 'exited', exited_reason = $3, updated_at = NOW() WHERE user_id = $1 AND id = $2 AND status = 'active' RETURNING ${ENR_COLS}`,
    [dataId, enrollmentId, reason.slice(0, 200)]
  );
}

export interface EnrollmentWithContact extends EnrollmentRow {
  full_name: string | null;
  email: string | null;
}

export async function listEnrollments(dataId: string, sequenceId: string, opts: { status?: EnrollmentStatus | null; limit?: number } = {}): Promise<EnrollmentWithContact[]> {
  const params: unknown[] = [dataId, sequenceId];
  const where = ["e.user_id = $1", "e.sequence_id = $2"];
  if (opts.status) {
    params.push(opts.status);
    where.push(`e.status = $${params.length}`);
  }
  params.push(Math.max(1, Math.min(500, opts.limit ?? 100)));
  return query<EnrollmentWithContact>(
    `SELECT e.id, e.user_id, e.sequence_id, e.contact_id, e.step_index, e.next_at, e.status, e.exited_reason, e.created_at, e.updated_at, c.full_name, c.email
       FROM sequence_enrollments e LEFT JOIN crm_contacts c ON c.id = e.contact_id WHERE ${where.join(" AND ")} ORDER BY e.created_at DESC LIMIT $${params.length}`,
    params
  );
}

/* ---------- reply detection ---------- */

/**
 * True when the contact wrote back after `since`: an inbound synced mail from
 * their address, or an inbound SMS/WhatsApp conversation from their number.
 * Best-effort; missing tables count as "no reply".
 */
export async function hasRepliedSince(dataId: string, contact: MarketingContact, since: string): Promise<boolean> {
  if (contact.email && (await tableExists("mail_messages"))) {
    const mail = await queryOne<{ id: string }>(
      `SELECT id FROM mail_messages WHERE user_id = $1 AND direction = 'in' AND lower(from_addr) LIKE $2 AND COALESCE(received_at, created_at) > $3 LIMIT 1`,
      [dataId, `%${escapeLike(contact.email.toLowerCase())}%`, since]
    ).catch(() => null);
    if (mail) return true;
  }
  if (contact.phone && (await tableExists("messaging_conversations"))) {
    const conv = await queryOne<{ id: string }>(`SELECT id FROM messaging_conversations WHERE user_id = $1 AND from_number = $2 AND updated_at > $3 LIMIT 1`, [dataId, contact.phone, since]).catch(() => null);
    if (conv) return true;
  }
  return false;
}

/* ---------- cron ---------- */

export interface RunDueResult {
  claimed: number;
  sent: number;
  exited: number;
  done: number;
  failed: number;
  skippedDuplicate?: number;
}

/** Cron worker: deliver due steps. Never throws. */
export async function runDueEnrollments(limit = 100): Promise<RunDueResult> {
  const result: RunDueResult = { claimed: 0, sent: 0, exited: 0, done: 0, failed: 0 };
  let due: Array<{ id: string }> = [];
  try {
    due = await query<{ id: string }>(
      `SELECT e.id FROM sequence_enrollments e JOIN sequences s ON s.id = e.sequence_id
        WHERE e.status = 'active' AND s.status = 'active' AND e.next_at IS NOT NULL AND e.next_at <= NOW() ORDER BY e.next_at ASC LIMIT $1`,
      [Math.max(1, Math.min(1000, limit))]
    );
  } catch (err) {
    console.error("[marketing] could not list due enrollments:", err);
    return result;
  }
  for (const { id } of due) {
    let enr: EnrollmentRow | null = null;
    try {
      // Claim by pushing next_at out; the step we are about to run is step_index.
      enr = await withRetry(() =>
        queryOne<EnrollmentRow>(`UPDATE sequence_enrollments SET next_at = NOW() + interval '1 hour', updated_at = NOW() WHERE id = $1 AND status = 'active' AND next_at <= NOW() RETURNING ${ENR_COLS}`, [id])
      );
    } catch (err) {
      console.error(`[marketing] claim enrollment ${id} failed:`, err);
      continue;
    }
    if (!enr) continue;
    result.claimed++;
    try {
      const seq = await getSequence(enr.user_id, enr.sequence_id);
      const steps = seq ? parseSteps(seq.steps) : [];
      const step = steps[enr.step_index];
      if (seq && step && enr.last_step_sent_index != null && enr.last_step_sent_index >= enr.step_index) {
        // This step was already sent but the enrollment was not advanced (crash/retry): advance, never re-send.
        result.skippedDuplicate = (result.skippedDuplicate ?? 0) + 1;
        await advance(enr, steps, result);
        continue;
      }
      if (!seq || !step) {
        await query(`UPDATE sequence_enrollments SET status = 'done', next_at = NULL, updated_at = NOW() WHERE id = $1`, [enr.id]);
        result.done++;
        continue;
      }
      const contact = await loadContact(enr.user_id, enr.contact_id);
      if (!contact) {
        await exitEnrollment(enr.user_id, enr.id, "contact_missing");
        result.exited++;
        continue;
      }
      if (await hasRepliedSince(enr.user_id, contact, enr.created_at)) {
        await exitEnrollment(enr.user_id, enr.id, "replied");
        result.exited++;
        continue;
      }
      const tpl = step.template_id ? await getTemplate(enr.user_id, step.template_id) : null;
      const subject = step.subject?.trim() || tpl?.subject || seq.name;
      const body = step.body_md?.trim() || tpl?.body_md || "";
      if (!body) {
        await query(`UPDATE sequence_enrollments SET status = 'exited', exited_reason = 'step_has_no_content', next_at = NULL, updated_at = NOW() WHERE id = $1`, [enr.id]);
        result.exited++;
        continue;
      }
      const outcome = await sendMarketingMessage(enr.user_id, { channel: step.channel, contact, subject, preheader: tpl?.preheader ?? null, body_md: body, sequenceId: seq.id });
      if (!outcome.ok) {
        if (outcome.reason === "no_consent" || outcome.reason === "opted_out" || outcome.reason === "tombstoned" || outcome.reason === "unknown_contact") {
          await exitEnrollment(enr.user_id, enr.id, outcome.reason);
          result.exited++;
        } else {
          // No address on this channel: skip the step but keep going.
          await advance(enr, steps, result);
        }
        continue;
      }
      result.sent++;
      // Mark the step sent before advancing so a failure between the two cannot cause a re-send.
      await query(
        `UPDATE sequence_enrollments SET last_step_sent_index = $2, last_step_sent_at = NOW(), updated_at = NOW() WHERE id = $1 AND (last_step_sent_index IS NULL OR last_step_sent_index < $2)`,
        [enr.id, enr.step_index]
      ).catch((err) => console.error(`[marketing] could not mark step sent for ${enr.id}:`, err));
      await advance(enr, steps, result);
    } catch (err) {
      result.failed++;
      console.error(`[marketing] enrollment ${enr.id} step failed:`, err instanceof Error ? err.message : err);
      await query(`UPDATE sequence_enrollments SET next_at = NOW() + interval '6 hours', updated_at = NOW() WHERE id = $1 AND status = 'active'`, [enr.id]).catch(() => undefined);
    }
  }
  return result;
}

async function advance(enr: EnrollmentRow, steps: SequenceStep[], result: RunDueResult): Promise<void> {
  const nextIndex = enr.step_index + 1;
  if (nextIndex >= steps.length) {
    await query(`UPDATE sequence_enrollments SET status = 'done', step_index = $2, next_at = NULL, updated_at = NOW() WHERE id = $1`, [enr.id, nextIndex]);
    result.done++;
    return;
  }
  await query(`UPDATE sequence_enrollments SET step_index = $2, next_at = $3, updated_at = NOW() WHERE id = $1`, [enr.id, nextIndex, dueAt(steps[nextIndex]).toISOString()]);
}

/**
 * Sweep: for every active `audience_join` sequence, enroll audience members
 * who are not enrolled yet (any status — a contact exits once, never loops).
 */
export async function enrollAudienceJoins(limit = 200): Promise<{ sequences: number; enrolled: number }> {
  const out = { sequences: 0, enrolled: 0 };
  let seqs: SequenceRow[] = [];
  try {
    seqs = await query<SequenceRow>(`SELECT ${COLS} FROM sequences WHERE trigger = 'audience_join' AND status = 'active' ORDER BY created_at ASC LIMIT 200`);
  } catch (err) {
    console.error("[marketing] could not list audience_join sequences:", err);
    return out;
  }
  let budget = Math.max(1, Math.min(5000, limit));
  for (const seq of seqs) {
    if (budget <= 0) break;
    const cfg = parseTriggerConfig(seq.trigger_config);
    if (!cfg.audience_id) continue;
    const audience = await getAudience(seq.user_id, cfg.audience_id).catch(() => null);
    if (!audience) continue;
    out.sequences++;
    const ids = await resolveAudienceIds(seq.user_id, parseAudienceDefinition(audience.definition), 5000).catch(() => [] as string[]);
    if (ids.length === 0) continue;
    const enrolled = await query<{ contact_id: string }>(`SELECT contact_id FROM sequence_enrollments WHERE user_id = $1 AND sequence_id = $2 AND contact_id = ANY($3)`, [seq.user_id, seq.id, ids]).catch(() => []);
    const have = new Set(enrolled.map((e) => e.contact_id));
    for (const contactId of ids) {
      if (budget <= 0) break;
      if (have.has(contactId)) continue;
      const r = await enroll(seq.user_id, seq.id, contactId, "audience_join").catch(() => null);
      if (r?.ok && r.created) {
        out.enrolled++;
        budget--;
      }
    }
  }
  return out;
}
