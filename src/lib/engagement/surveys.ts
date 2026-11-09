import { createHash, randomUUID } from "crypto";
import { z } from "zod";
import { query, queryOne } from "@/lib/dsql";
import { emitEvent } from "@/lib/events/bus";
import { createTicket } from "@/lib/helpdesk/tickets";
import { getBranding } from "@/lib/branding";
import { signOpaque, trackingOrigin, unsubscribeContactUrl, unsubscribeOneClickUrl, verifySignedPayload } from "@/lib/marketing/tracking";
import { enqueueNotification } from "@/lib/notifications/outbox";
import { canSendMarketing, isTombstoned } from "@/lib/privacy/consent";
import { tableExists } from "@/lib/table-exists";
import {
  QuestionsSchema, SURVEY_CHANNELS, SURVEY_KINDS, csatStats, defaultQuestions, distribution, isDetractor, npsStats, parseQuestions, qualifiesForReviewPrompt, safeReviewUrl, scoreRange, trendByWeek,
  type Question, type SurveyChannel, type SurveyKind,
} from "./pure";

/* ── survey definitions ────────────────────────────────────────────────── */

export const SURVEY_TRIGGERS = ["order.fulfilled", "shipment.delivered", "invoice.paid", "ticket.resolved", "booking.completed"] as const;

export const SurveyInputSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    kind: z.enum(SURVEY_KINDS),
    questions: QuestionsSchema.optional(),
    trigger_event: z.enum(SURVEY_TRIGGERS).nullable().optional(),
    delay_hours: z.number().int().min(0).max(24 * 60).optional(),
    channel: z.enum(SURVEY_CHANNELS).optional(),
    active: z.boolean().optional(),
    thank_you_md: z.string().trim().max(2000).nullable().optional(),
    public_review_prompt: z.boolean().optional(),
    review_url: z.string().trim().max(500).nullable().optional(),
  })
  .strict()
  .refine((v) => !v.review_url || safeReviewUrl(v.review_url) !== null, { path: ["review_url"], message: "Review link must be an https URL" });
export type SurveyInput = z.infer<typeof SurveyInputSchema>;

export interface SurveyDTO {
  id: string;
  name: string;
  kind: SurveyKind;
  questions: Question[];
  trigger_event: string | null;
  delay_hours: number;
  channel: SurveyChannel;
  active: boolean;
  thank_you_md: string | null;
  public_review_prompt: boolean;
  review_url: string | null;
  created_at: string;
}
interface SurveyRow { id: string; user_id: string; name: string; kind: SurveyKind; questions: string; trigger_event: string | null; delay_hours: number; channel: SurveyChannel; active: boolean; thank_you_md: string | null; public_review_prompt: boolean; review_url: string | null; created_at: string | Date }
const SCOLS = "id, user_id, name, kind, questions, trigger_event, delay_hours, channel, active, thank_you_md, public_review_prompt, review_url, created_at";
const toSurvey = (r: SurveyRow): SurveyDTO => ({ id: r.id, name: r.name, kind: r.kind, questions: parseQuestions(r.questions), trigger_event: r.trigger_event, delay_hours: Number(r.delay_hours), channel: r.channel, active: Boolean(r.active), thank_you_md: r.thank_you_md, public_review_prompt: Boolean(r.public_review_prompt), review_url: r.review_url, created_at: new Date(r.created_at).toISOString() });

export async function createSurvey(dataId: string, input: SurveyInput): Promise<SurveyDTO> {
  const id = randomUUID();
  await query(
    `INSERT INTO surveys (id, user_id, name, kind, questions, trigger_event, delay_hours, channel, active, thank_you_md, public_review_prompt, review_url) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [id, dataId, input.name, input.kind, JSON.stringify(input.questions ?? defaultQuestions(input.kind)), input.trigger_event ?? null, input.delay_hours ?? 24, input.channel ?? "email", input.active ?? true, input.thank_you_md ?? "Thank you for your feedback!", input.public_review_prompt ?? false, input.review_url ?? null]
  );
  return (await getSurvey(dataId, id)) as SurveyDTO;
}
export async function updateSurvey(dataId: string, id: string, patch: Partial<SurveyInput>): Promise<SurveyDTO> {
  const cur = await getSurvey(dataId, id);
  if (!cur) throw new Error("Survey not found");
  if (patch.review_url && safeReviewUrl(patch.review_url) === null) throw new Error("Review link must be an https URL");
  const m = { ...cur, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) } as SurveyDTO;
  await query(
    `UPDATE surveys SET name=$3, kind=$4, questions=$5, trigger_event=$6, delay_hours=$7, channel=$8, active=$9, thank_you_md=$10, public_review_prompt=$11, review_url=$12, updated_at=NOW() WHERE id=$1 AND user_id=$2`,
    [id, dataId, m.name, m.kind, JSON.stringify(m.questions), m.trigger_event, m.delay_hours, m.channel, m.active, m.thank_you_md, m.public_review_prompt, m.review_url]
  );
  return (await getSurvey(dataId, id)) as SurveyDTO;
}
export async function getSurvey(dataId: string, id: string): Promise<SurveyDTO | null> {
  const r = await queryOne<SurveyRow>(`SELECT ${SCOLS} FROM surveys WHERE id = $1 AND user_id = $2`, [id, dataId]);
  return r ? toSurvey(r) : null;
}
export async function listSurveys(dataId: string): Promise<SurveyDTO[]> {
  const rows = await query<SurveyRow>(`SELECT ${SCOLS} FROM surveys WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT 200`, [dataId]);
  return rows.map(toSurvey);
}

/* ── tokens ────────────────────────────────────────────────────────────── */

/** Survey link token: HMAC over `s|<requestId>` with the marketing tracking key. */
export const surveyToken = (requestId: string): string => signOpaque(`s|${requestId}`);
export const surveyTokenHash = (token: string): string => createHash("sha256").update(token).digest("hex");
const ID_RE = /^[A-Za-z0-9_.:-]{1,120}$/;

/** Constant-time verify; returns the request id or null. */
export function verifySurveyToken(token: string | null | undefined): string | null {
  const payload = verifySignedPayload(token);
  if (!payload) return null;
  const parts = payload.split("|");
  return parts.length === 2 && parts[0] === "s" && ID_RE.test(parts[1]) ? parts[1] : null;
}
export const surveyUrl = (requestId: string): string => `${trackingOrigin()}/s/${surveyToken(requestId)}`;

/* ── requests ──────────────────────────────────────────────────────────── */

export interface RequestRow { id: string; user_id: string; survey_id: string; contact_id: string | null; entity_kind: string; entity_id: string; token_hash: string; status: "queued" | "sent" | "opened" | "completed" | "expired" | "skipped"; send_after: string | Date | null; sent_at: string | Date | null; completed_at: string | Date | null; expires_at: string | Date | null; created_at: string | Date }
const RCOLS = "id, user_id, survey_id, contact_id, entity_kind, entity_id, token_hash, status, send_after, sent_at, completed_at, expires_at, created_at";

/** Create (or find) the one request per (survey, entity). `created` is false on a duplicate. */
export async function scheduleSurveyRequest(dataId: string, survey: SurveyDTO, entity: { kind: string; id: string; contactId: string | null }, now: Date = new Date()): Promise<{ id: string; created: boolean }> {
  const existing = await queryOne<{ id: string }>(`SELECT id FROM survey_requests WHERE survey_id = $1 AND entity_kind = $2 AND entity_id = $3`, [survey.id, entity.kind, entity.id]);
  if (existing) return { id: existing.id, created: false };
  const id = randomUUID();
  const sendAfter = new Date(now.getTime() + survey.delay_hours * 3_600_000);
  try {
    await query(
      `INSERT INTO survey_requests (id, user_id, survey_id, contact_id, entity_kind, entity_id, token_hash, status, send_after, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,'queued',$8,$9)`,
      [id, dataId, survey.id, entity.contactId, entity.kind, entity.id, surveyTokenHash(surveyToken(id)), sendAfter.toISOString(), new Date(sendAfter.getTime() + 30 * 86_400_000).toISOString()]
    );
  } catch (err) {
    const c = err && typeof err === "object" && "code" in err ? String((err as { code: unknown }).code) : "";
    if (c === "23505") {
      const again = await queryOne<{ id: string }>(`SELECT id FROM survey_requests WHERE survey_id = $1 AND entity_kind = $2 AND entity_id = $3`, [survey.id, entity.kind, entity.id]);
      if (again) return { id: again.id, created: false };
    }
    throw err;
  }
  return { id, created: true };
}

async function orgName(dataId: string): Promise<string> {
  const b = await getBranding(dataId).catch(() => null);
  if (b?.configured && b.brand_name) return b.brand_name;
  const org = await queryOne<{ name: string }>(`SELECT name FROM organizations WHERE owner_user_id = $1 ORDER BY created_at ASC LIMIT 1`, [dataId]).catch(() => null);
  return org?.name ?? b?.brand_name ?? "us";
}

async function emailOptedOut(dataId: string, contact: { id: string; email: string | null }): Promise<boolean> {
  try {
    const opt = await queryOne(`SELECT id FROM contact_optouts WHERE user_id = $1 AND channel = ANY($2) AND (contact_id = $3 OR ($4::text IS NOT NULL AND lower(email) = lower($4))) LIMIT 1`, [dataId, ["email", "all"], contact.id, contact.email]);
    if (opt) return true;
    return await isTombstoned(dataId, contact.email, "marketing_email");
  } catch {
    return true; // fail closed
  }
}

/** Deliver one queued request. Email is transactional (once per transaction) but honours opt-outs; SMS needs marketing_sms consent. */
async function dispatchRequest(r: RequestRow): Promise<"sent" | "skipped"> {
  const survey = await getSurvey(r.user_id, r.survey_id);
  const markSkipped = async () => { await query(`UPDATE survey_requests SET status = 'skipped' WHERE id = $1 AND status = 'queued'`, [r.id]); return "skipped" as const; };
  if (!survey || !survey.active) return markSkipped();
  if (survey.channel === "link") {
    await query(`UPDATE survey_requests SET status = 'sent', sent_at = NOW() WHERE id = $1 AND status = 'queued'`, [r.id]);
    return "sent";
  }
  if (!r.contact_id) return markSkipped();
  const contact = await queryOne<{ id: string; full_name: string; email: string | null; phone: string | null }>(`SELECT id, full_name, email, phone FROM crm_contacts WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`, [r.contact_id, r.user_id]);
  if (!contact) return markSkipped();
  // Claim before sending so a concurrent tick never double-sends.
  const claimed = await query<{ id: string }>(`UPDATE survey_requests SET status = 'sent', sent_at = NOW() WHERE id = $1 AND status = 'queued' RETURNING id`, [r.id]);
  if (claimed.length === 0) return "skipped";
  const url = surveyUrl(r.id);
  const name = await orgName(r.user_id);
  const first = contact.full_name.split(/\s+/)[0] || "there";
  let ok = false;
  if (survey.channel === "email" && contact.email && !(await emailOptedOut(r.user_id, contact))) {
    const unsub = unsubscribeContactUrl(r.user_id, contact.id, "email");
    const id = await enqueueNotification(r.user_id, {
      channel: "email",
      recipient: contact.email,
      subject: `How did we do? ${name}`,
      body: `Hi ${first},\n\nThanks for choosing ${name}. It takes under a minute to tell us how we did:\n\n${url}\n\nIf you would rather not receive requests like this, unsubscribe: ${unsub}`,
      data: { kind: "survey_request", category: "customers", survey_id: survey.id, request_id: r.id, contact_id: contact.id, headers: { "List-Unsubscribe": `<${unsubscribeOneClickUrl(unsub)}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } },
    });
    ok = !id.startsWith("skipped:");
  } else if (survey.channel === "sms" && contact.phone) {
    const d = await canSendMarketing(r.user_id, contact.id, "sms");
    if (d.allowed) {
      const id = await enqueueNotification(r.user_id, { channel: "sms", recipient: contact.phone, body: `${name}: how did we do? ${url} Reply STOP to opt out.`, data: { kind: "survey_request", category: "marketing", survey_id: survey.id, request_id: r.id, contact_id: contact.id } });
      ok = !id.startsWith("skipped:");
    }
  }
  if (!ok) {
    await query(`UPDATE survey_requests SET status = 'skipped', sent_at = NULL WHERE id = $1 AND status = 'sent'`, [r.id]);
    return "skipped";
  }
  return "sent";
}

/** Send queued requests whose delay has passed; expire stale ones. */
export async function dispatchDueRequests(limit = 100, now: Date = new Date()): Promise<{ sent: number; skipped: number; expired: number }> {
  const due = await query<RequestRow>(`SELECT ${RCOLS} FROM survey_requests WHERE status = 'queued' AND send_after <= $1 ORDER BY send_after ASC LIMIT $2`, [now.toISOString(), limit]);
  let sent = 0;
  let skipped = 0;
  for (const r of due) {
    try {
      if ((await dispatchRequest(r)) === "sent") sent++;
      else skipped++;
    } catch (err) {
      console.error(`[surveys] dispatch ${r.id} failed:`, err);
    }
  }
  const exp = await query<{ id: string }>(`UPDATE survey_requests SET status = 'expired' WHERE id IN (SELECT id FROM survey_requests WHERE status IN ('sent','opened','queued') AND expires_at < $1 LIMIT $2) RETURNING id`, [now.toISOString(), limit]);
  return { sent, skipped, expired: exp.length };
}

/* ── event processor ───────────────────────────────────────────────────── */

const CURSOR = "engagement";
const EVENT_ENTITY: Record<string, string> = { "order.fulfilled": "order", "shipment.delivered": "shipment", "invoice.paid": "invoice", "ticket.resolved": "ticket" };

async function contactForEvent(dataId: string, type: string, entityId: string, data: Record<string, unknown>): Promise<string | null> {
  if (typeof data.contact_id === "string" && data.contact_id) return data.contact_id;
  if (type === "invoice.paid") return (await queryOne<{ contact_id: string | null }>(`SELECT contact_id FROM invoices WHERE id = $1 AND user_id = $2`, [entityId, dataId]))?.contact_id ?? null;
  if (type === "ticket.resolved") return (await queryOne<{ contact_id: string | null }>(`SELECT contact_id FROM tickets WHERE id = $1 AND user_id = $2`, [entityId, dataId]))?.contact_id ?? null;
  if (type === "shipment.delivered") return (await queryOne<{ contact_id: string | null }>(`SELECT o.contact_id FROM shipments s JOIN orders o ON o.id = s.order_id AND o.user_id = s.user_id WHERE s.id = $1 AND s.user_id = $2`, [entityId, dataId]).catch(() => null))?.contact_id ?? null;
  return null;
}

/**
 * Cron: (1) create survey requests for new events past the `engagement` cursor
 * (events fully handled advance the cursor, like chatops), (2) sweep completed
 * bookings, (3) dispatch due requests. Dedupe is the unique (survey, entity).
 */
export async function processEngagementEvents(limit = 200, budgetMs = 25_000): Promise<{ scanned: number; scheduled: number; bookings: number; sent: number }> {
  if (!(await tableExists("survey_requests"))) return { scanned: 0, scheduled: 0, bookings: 0, sent: 0 };
  const deadline = Date.now() + budgetMs;
  const cur = await queryOne<{ name: string }>(`SELECT name FROM engagement_cursors WHERE name = $1`, [CURSOR]);
  let scanned = 0;
  let scheduled = 0;
  if (!cur) {
    await query(`INSERT INTO engagement_cursors (name, last_event_at, last_event_id, updated_at) VALUES ($1, NOW(), '', NOW()) ON CONFLICT (name) DO NOTHING`, [CURSOR]);
  } else {
    const events = await query<{ id: string; user_id: string; type: string; entity: string; entity_id: string; data: string | null }>(
      `SELECT e.id, e.user_id, e.type, e.entity, e.entity_id, e.data FROM events e, engagement_cursors c
        WHERE c.name = $1 AND e.type = ANY($3) AND (e.created_at > COALESCE(c.last_event_at, 'epoch'::timestamptz) OR (e.created_at = c.last_event_at AND e.id > COALESCE(c.last_event_id, '')))
        ORDER BY e.created_at ASC, e.id ASC LIMIT $2`,
      [CURSOR, Math.min(Math.max(limit, 1), 1000), Object.keys(EVENT_ENTITY)]
    );
    let done = 0;
    const surveysByUser = new Map<string, SurveyDTO[]>();
    for (const evt of events) {
      if (done > 0 && Date.now() > deadline) break;
      done++;
      let list = surveysByUser.get(evt.user_id);
      if (!list) { list = (await listSurveys(evt.user_id)).filter((s) => s.active && s.trigger_event); surveysByUser.set(evt.user_id, list); }
      const matching = list.filter((s) => s.trigger_event === evt.type);
      if (matching.length === 0) continue;
      let data: Record<string, unknown> = {};
      try { const v = evt.data ? (JSON.parse(evt.data) as unknown) : {}; if (v && typeof v === "object" && !Array.isArray(v)) data = v as Record<string, unknown>; } catch { /* empty */ }
      const contactId = await contactForEvent(evt.user_id, evt.type, evt.entity_id, data);
      for (const s of matching) {
        const r = await scheduleSurveyRequest(evt.user_id, s, { kind: EVENT_ENTITY[evt.type] ?? evt.entity, id: evt.entity_id, contactId });
        if (r.created) scheduled++;
      }
    }
    scanned = done;
    if (done > 0) await query(`UPDATE engagement_cursors SET last_event_at = (SELECT created_at FROM events WHERE id = $2), last_event_id = $2, updated_at = NOW() WHERE name = $1`, [CURSOR, events[done - 1].id]);
  }
  const bookings = await sweepCompletedBookings(limit);
  const d = await dispatchDueRequests(limit);
  return { scanned, scheduled: scheduled + bookings, bookings, sent: d.sent };
}

/** Confirmed/completed bookings whose end passed 2+ hours ago, for surveys triggered by `booking.completed`. */
export async function sweepCompletedBookings(limit = 200, now: Date = new Date()): Promise<number> {
  const surveys = await query<SurveyRow>(`SELECT ${SCOLS} FROM surveys WHERE active = TRUE AND trigger_event = 'booking.completed'`);
  let created = 0;
  for (const row of surveys) {
    const s = toSurvey(row);
    const bookings = await query<{ id: string; contact_id: string | null }>(
      `SELECT id, contact_id FROM bookings WHERE user_id = $1 AND status IN ('confirmed','completed') AND contact_id IS NOT NULL AND ends_at < $2 AND ends_at > $3 ORDER BY ends_at ASC LIMIT $4`,
      [row.user_id, new Date(now.getTime() - 2 * 3_600_000).toISOString(), new Date(now.getTime() - 14 * 86_400_000).toISOString(), limit]
    );
    for (const b of bookings) {
      const r = await scheduleSurveyRequest(row.user_id, s, { kind: "booking", id: b.id, contactId: b.contact_id }, now);
      if (r.created) created++;
    }
  }
  return created;
}

/* ── public page ───────────────────────────────────────────────────────── */

export interface PublicSurvey {
  request_id: string;
  org_name: string;
  name: string;
  kind: SurveyKind;
  questions: Question[];
  status: RequestRow["status"];
  already_completed: boolean;
  allow_public_consent: boolean;
}

/** Resolve a link to its survey for rendering; null for any invalid/forged/expired token. Marks the request opened. */
export async function loadPublicSurvey(token: string): Promise<PublicSurvey | null> {
  const requestId = verifySurveyToken(token);
  if (!requestId) return null;
  const r = await queryOne<RequestRow>(`SELECT ${RCOLS} FROM survey_requests WHERE id = $1`, [requestId]);
  if (!r || r.token_hash !== surveyTokenHash(token)) return null;
  if (r.status === "skipped") return null;
  const expired = r.status === "expired" || (r.status !== "completed" && r.expires_at && new Date(r.expires_at).getTime() < Date.now());
  if (expired) return null;
  const survey = await getSurvey(r.user_id, r.survey_id);
  if (!survey) return null;
  if (r.status === "sent" || r.status === "queued") await query(`UPDATE survey_requests SET status = 'opened' WHERE id = $1 AND status IN ('queued','sent')`, [r.id]);
  return { request_id: r.id, org_name: await orgName(r.user_id), name: survey.name, kind: survey.kind, questions: survey.questions, status: r.status === "completed" ? "completed" : "opened", already_completed: r.status === "completed", allow_public_consent: true };
}

export const SubmitSchema = z
  .object({
    answers: z.record(z.string().max(40), z.union([z.string().max(2000), z.number().int().min(0).max(10)])).default({}),
    public_ok: z.boolean().optional(),
  })
  .strict();
export type SubmitInput = z.infer<typeof SubmitSchema>;

export class SurveyError extends Error {
  constructor(public readonly code: "invalid_token" | "already_completed" | "invalid_answer" | "expired", message: string) {
    super(message);
    this.name = "SurveyError";
  }
}

export interface SubmitResult { thank_you: string; review_url: string | null; score: number | null }

/** Validate and store one response (exactly one per request; the conditional status update is the lock). */
export async function submitSurveyResponse(token: string, input: SubmitInput, now: Date = new Date()): Promise<SubmitResult> {
  const requestId = verifySurveyToken(token);
  if (!requestId) throw new SurveyError("invalid_token", "This link is not valid");
  const r = await queryOne<RequestRow>(`SELECT ${RCOLS} FROM survey_requests WHERE id = $1`, [requestId]);
  if (!r || r.token_hash !== surveyTokenHash(token) || r.status === "skipped") throw new SurveyError("invalid_token", "This link is not valid");
  if (r.status === "completed") throw new SurveyError("already_completed", "You have already responded. Thank you!");
  if (r.status === "expired" || (r.expires_at && new Date(r.expires_at).getTime() < now.getTime())) throw new SurveyError("expired", "This survey has closed");
  const survey = await getSurvey(r.user_id, r.survey_id);
  if (!survey) throw new SurveyError("invalid_token", "This link is not valid");

  const answers: Record<string, string | number> = {};
  let score: number | null = null;
  let comment: string | null = null;
  for (const q of survey.questions) {
    const v = input.answers[q.id];
    const empty = v === undefined || v === "" || v === null;
    if (empty) {
      if (q.required) throw new SurveyError("invalid_answer", `Please answer: ${q.label}`);
      continue;
    }
    if (q.type === "rating" || q.type === "nps") {
      const n = typeof v === "number" ? v : Number(v);
      const range = scoreRange(survey.kind, q.type);
      const lo = q.type === "nps" ? 0 : range.min;
      const hi = q.type === "nps" ? 10 : Math.min(range.max, 5);
      if (!Number.isInteger(n) || n < lo || n > hi) throw new SurveyError("invalid_answer", `Choose a score from ${lo} to ${hi}`);
      answers[q.id] = n;
      if (score === null) score = n;
    } else if (q.type === "choice") {
      if (typeof v !== "string" || !(q.options ?? []).includes(v)) throw new SurveyError("invalid_answer", "Choose one of the listed options");
      answers[q.id] = v;
    } else {
      const text = String(v).trim().slice(0, 2000);
      answers[q.id] = text;
      if (comment === null && text) comment = text;
    }
  }

  const claimed = await query<{ id: string }>(`UPDATE survey_requests SET status = 'completed', completed_at = NOW() WHERE id = $1 AND status IN ('queued','sent','opened') RETURNING id`, [r.id]);
  if (claimed.length === 0) throw new SurveyError("already_completed", "You have already responded. Thank you!");
  const responseId = randomUUID();
  try {
    await query(`INSERT INTO survey_responses (id, user_id, survey_id, request_id, contact_id, score, answers, comment, public) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [responseId, r.user_id, survey.id, r.id, r.contact_id, score, JSON.stringify(answers), comment, input.public_ok === true]);
  } catch (err) {
    await query(`UPDATE survey_requests SET status = 'opened', completed_at = NULL WHERE id = $1`, [r.id]).catch(() => undefined);
    throw err;
  }
  void emitEvent(r.user_id, { type: "survey.completed", entity: "survey_response", entityId: responseId, data: { survey_id: survey.id, score, kind: survey.kind, contact_id: r.contact_id } });
  if (isDetractor(survey.kind, score)) await raiseDetractorAlert(r.user_id, survey, { responseId, score: score as number, comment, contactId: r.contact_id });
  const review = survey.public_review_prompt && qualifiesForReviewPrompt(survey.kind, score) ? safeReviewUrl(survey.review_url) : null;
  return { thank_you: survey.thank_you_md ?? "Thank you for your feedback!", review_url: review, score };
}

async function raiseDetractorAlert(dataId: string, survey: SurveyDTO, r: { responseId: string; score: number; comment: string | null; contactId: string | null }): Promise<void> {
  try {
    const contact = r.contactId ? await queryOne<{ full_name: string; email: string | null }>(`SELECT full_name, email FROM crm_contacts WHERE id = $1 AND user_id = $2`, [r.contactId, dataId]) : null;
    const ticket = await createTicket(dataId, {
      subject: `Low survey score (${r.score}) from ${contact?.full_name ?? "a customer"}`,
      body: `${survey.name}: ${survey.kind.toUpperCase()} score ${r.score}.${r.comment ? `\n\n"${r.comment}"` : ""}`,
      priority: "high",
      source: "survey",
      contact_id: r.contactId,
      requester_email: contact?.email ?? null,
      requester_name: contact?.full_name ?? null,
      tags: ["survey", "detractor"],
      author_kind: "system",
    });
    void emitEvent(dataId, { type: "survey.detractor", entity: "survey_response", entityId: r.responseId, data: { survey_id: survey.id, score: r.score, contact_id: r.contactId, ticket_id: ticket.id } });
    await enqueueNotification(dataId, { channel: "in_app", recipient: dataId, subject: `Low survey score: ${r.score}`, body: r.comment?.slice(0, 300) ?? `${contact?.full_name ?? "A customer"} left a low score.`, data: { kind: "survey.detractor", category: "customers", response_id: r.responseId, ticket_id: ticket.id, href: `/helpdesk?ticket=${ticket.id}` } });
  } catch (err) {
    console.error("[surveys] detractor alert failed:", err);
  }
}

/* ── results ───────────────────────────────────────────────────────────── */

export interface SurveyResults {
  survey: SurveyDTO;
  responses: number;
  sent: number;
  response_rate: number | null;
  nps: ReturnType<typeof npsStats> | null;
  csat: ReturnType<typeof csatStats> | null;
  average: number | null;
  distribution: { min: number; max: number; counts: number[] };
  trend: Array<{ week: string; responses: number; value: number | null }>;
  comments: Array<{ id: string; score: number | null; comment: string; contact_name: string | null; public: boolean; created_at: string; testimonial_id: string | null }>;
}

export async function surveyResults(dataId: string, surveyId: string, opts: { days?: number } = {}): Promise<SurveyResults | null> {
  const survey = await getSurvey(dataId, surveyId);
  if (!survey) return null;
  const since = new Date(Date.now() - (opts.days ?? 90) * 86_400_000).toISOString();
  const rows = await query<{ id: string; score: number | null; comment: string | null; public: boolean; created_at: string | Date; contact_name: string | null; testimonial_id: string | null }>(
    `SELECT r.id, r.score, r.comment, r.public, r.created_at, c.full_name AS contact_name, t.id AS testimonial_id
       FROM survey_responses r LEFT JOIN crm_contacts c ON c.id = r.contact_id AND c.user_id = r.user_id LEFT JOIN testimonials t ON t.response_id = r.id AND t.user_id = r.user_id
      WHERE r.user_id = $1 AND r.survey_id = $2 AND r.created_at >= $3 ORDER BY r.created_at DESC LIMIT 5000`,
    [dataId, surveyId, since]
  );
  const sentRow = await queryOne<{ n: string }>(`SELECT COUNT(*) AS n FROM survey_requests WHERE user_id = $1 AND survey_id = $2 AND created_at >= $3 AND status IN ('sent','opened','completed','expired')`, [dataId, surveyId, since]);
  const scores = rows.map((r) => r.score).filter((s): s is number => s !== null);
  const range = scoreRange(survey.kind, survey.questions[0]?.type);
  const sent = Number(sentRow?.n ?? 0);
  return {
    survey,
    responses: rows.length,
    sent,
    response_rate: sent === 0 ? null : Math.round((rows.length / sent) * 100),
    nps: survey.kind === "nps" ? npsStats(scores) : null,
    csat: survey.kind === "csat" ? csatStats(scores) : null,
    average: scores.length ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 100) / 100 : null,
    distribution: { ...range, counts: distribution(scores, range.min, range.max) },
    trend: trendByWeek(rows.map((r) => ({ score: r.score, created_at: r.created_at })), survey.kind),
    comments: rows.filter((r) => r.comment).slice(0, 100).map((r) => ({ id: r.id, score: r.score, comment: r.comment as string, contact_name: r.contact_name, public: Boolean(r.public), created_at: new Date(r.created_at).toISOString(), testimonial_id: r.testimonial_id })),
  };
}

/** Org data id behind a survey link (for branding the public page); null for invalid tokens. */
export async function surveyOrgId(token: string): Promise<string | null> {
  const requestId = verifySurveyToken(token);
  if (!requestId) return null;
  const r = await queryOne<{ user_id: string; token_hash: string }>(`SELECT user_id, token_hash FROM survey_requests WHERE id = $1`, [requestId]);
  return r && r.token_hash === surveyTokenHash(token) ? r.user_id : null;
}
