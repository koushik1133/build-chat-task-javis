import { query, queryOne } from "@/lib/dsql";
import { escapeLike } from "@/lib/like";
import { grantedSubset } from "@/lib/privacy/consent";
import { firstNameOf } from "./twiml";
import { CAMPAIGN_STATUSES, emptyStats, filterDnc, normalizePhone, parseTags, type CampaignStats, type CampaignStatus } from "./window";

/**
 * Voice campaign persistence: campaigns, their targets (one row per phone),
 * audience building from the CRM, stats and the do-not-call list.
 */

export interface CampaignRow {
  id: string;
  user_id: string;
  name: string;
  script: string;
  voice: string;
  status: CampaignStatus;
  schedule_at: string | null;
  window_start: string;
  window_end: string;
  timezone: string;
  max_attempts: number;
  /** NULL = true: skip contacts without a marketing_voice consent grant. */
  require_consent: boolean | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface TargetRow {
  id: string;
  user_id: string;
  campaign_id: string;
  contact_id: string | null;
  phone: string;
  first_name: string | null;
  status: string;
  attempts: number;
  last_attempt_at: string | null;
  call_sid: string | null;
  outcome: string | null;
  created_at: string;
}

export interface CallRow {
  id: string;
  campaign_id: string | null;
  target_id: string | null;
  call_sid: string | null;
  direction: string;
  status: string;
  duration_s: number | null;
  recording_url: string | null;
  transcript: string | null;
  created_at: string;
}

const CAMPAIGN_COLS = `id, user_id, name, script, voice, status, schedule_at, window_start, window_end, timezone, max_attempts, require_consent, created_by, created_at, updated_at`;
const TARGET_COLS = `id, user_id, campaign_id, contact_id, phone, first_name, status, attempts, last_attempt_at, call_sid, outcome, created_at`;

export interface CreateCampaignInput {
  name: string;
  script: string;
  voice: string;
  schedule_at: string | null;
  window_start: string;
  window_end: string;
  timezone: string;
  max_attempts: number;
  /** Default true: only contacts with marketing_voice consent are dialled. */
  require_consent?: boolean;
  created_by: string | null;
}

export async function createCampaign(dataId: string, input: CreateCampaignInput): Promise<CampaignRow> {
  const row = await queryOne<CampaignRow>(
    `INSERT INTO voice_campaigns (user_id, name, script, voice, status, schedule_at, window_start, window_end, timezone, max_attempts, require_consent, created_by, created_at, updated_at)
     VALUES ($1,$2,$3,$4,'draft',$5,$6,$7,$8,$9,$10,$11,NOW(),NOW()) RETURNING ${CAMPAIGN_COLS}`,
    [dataId, input.name, input.script, input.voice, input.schedule_at, input.window_start, input.window_end, input.timezone, input.max_attempts, input.require_consent ?? true, input.created_by]
  );
  if (!row) throw new Error("Insert returned no row");
  return row;
}

export async function listCampaigns(dataId: string): Promise<Array<CampaignRow & { stats: CampaignStats }>> {
  const rows = await query<CampaignRow>(`SELECT ${CAMPAIGN_COLS} FROM voice_campaigns WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100`, [dataId]);
  if (rows.length === 0) return [];
  const counts = await query<{ campaign_id: string; status: string; n: string | number; interested: string | number }>(
    `SELECT campaign_id, status, COUNT(*) AS n,
            SUM(CASE WHEN outcome LIKE '%"interested"%' THEN 1 ELSE 0 END) AS interested
       FROM voice_campaign_targets WHERE user_id = $1 AND campaign_id = ANY($2)
      GROUP BY campaign_id, status`,
    [dataId, rows.map((r) => r.id)]
  ).catch(() => []);
  const byCampaign = new Map<string, CampaignStats>();
  for (const c of counts) {
    const s = byCampaign.get(c.campaign_id) ?? emptyStats();
    const n = Number(c.n) || 0;
    s.total += n;
    if (c.status in s) s[c.status as keyof CampaignStats] += n;
    s.interested += Number(c.interested) || 0;
    byCampaign.set(c.campaign_id, s);
  }
  return rows.map((r) => ({ ...r, stats: byCampaign.get(r.id) ?? emptyStats() }));
}

export async function getCampaign(dataId: string, id: string): Promise<CampaignRow | null> {
  return queryOne<CampaignRow>(`SELECT ${CAMPAIGN_COLS} FROM voice_campaigns WHERE id = $1 AND user_id = $2`, [id, dataId]);
}

export async function listTargets(dataId: string, campaignId: string, limit = 500): Promise<TargetRow[]> {
  return query<TargetRow>(
    `SELECT ${TARGET_COLS} FROM voice_campaign_targets WHERE user_id = $1 AND campaign_id = $2 ORDER BY created_at ASC LIMIT $3`,
    [dataId, campaignId, Math.max(1, Math.min(2000, limit))]
  );
}

export async function listCalls(dataId: string, campaignId: string, limit = 200): Promise<CallRow[]> {
  return query<CallRow>(
    `SELECT id, campaign_id, target_id, call_sid, direction, status, duration_s, recording_url, transcript, created_at
       FROM voice_calls WHERE user_id = $1 AND campaign_id = $2 ORDER BY created_at DESC LIMIT $3`,
    [dataId, campaignId, Math.max(1, Math.min(1000, limit))]
  );
}

export function statsFor(targets: TargetRow[]): CampaignStats {
  const s = emptyStats();
  for (const t of targets) {
    s.total++;
    if (t.status in s) s[t.status as keyof CampaignStats]++;
    if (t.outcome?.includes('"interested"')) s.interested++;
  }
  return s;
}

export function isCampaignStatus(v: unknown): v is CampaignStatus {
  return typeof v === "string" && (CAMPAIGN_STATUSES as readonly string[]).includes(v);
}

/** Allowed status transitions from the UI/API. */
export function canTransition(from: CampaignStatus, to: CampaignStatus): boolean {
  if (from === to) return true;
  const allowed: Record<CampaignStatus, CampaignStatus[]> = {
    draft: ["scheduled", "running"],
    scheduled: ["running", "paused", "draft"],
    running: ["paused", "done"],
    paused: ["running", "done"],
    done: [],
  };
  return allowed[from].includes(to);
}

export async function setCampaignStatus(dataId: string, id: string, status: CampaignStatus): Promise<CampaignRow | null> {
  return queryOne<CampaignRow>(
    `UPDATE voice_campaigns SET status = $1, updated_at = NOW() WHERE id = $2 AND user_id = $3 RETURNING ${CAMPAIGN_COLS}`,
    [status, id, dataId]
  );
}

// ── Audience ─────────────────────────────────────────────────────────────────

export interface AudienceFilter {
  lifecycle?: string | null;
  tag?: string | null;
  q?: string | null;
}

export interface AudienceInput {
  contact_ids?: string[];
  filter?: AudienceFilter | null;
  /** Ad-hoc numbers not in the CRM. */
  phones?: Array<{ phone: string; first_name?: string | null }>;
}

interface ContactCandidate {
  id: string;
  full_name: string;
  phone: string | null;
  tags: string | null;
}

/** True when the filter actually narrows the CRM; `{}` (or all-blank fields) selects nobody. */
export function hasFilterCriteria(filter: AudienceFilter | null | undefined): filter is AudienceFilter {
  if (!filter) return false;
  return Boolean(filter.lifecycle?.trim() || filter.tag?.trim() || filter.q?.trim());
}

/** Contacts with a phone that match the filter (max 1000). */
export async function resolveContacts(dataId: string, input: AudienceInput): Promise<ContactCandidate[]> {
  const out = new Map<string, ContactCandidate>();
  if (input.contact_ids?.length) {
    const rows = await query<ContactCandidate>(
      `SELECT id, full_name, phone, tags FROM crm_contacts WHERE user_id = $1 AND id = ANY($2) AND deleted_at IS NULL AND phone IS NOT NULL`,
      [dataId, input.contact_ids.slice(0, 1000)]
    );
    for (const r of rows) out.set(r.id, r);
  }
  if (hasFilterCriteria(input.filter)) {
    const params: unknown[] = [dataId];
    let sql = `SELECT id, full_name, phone, tags FROM crm_contacts WHERE user_id = $1 AND deleted_at IS NULL AND phone IS NOT NULL AND phone <> ''`;
    if (input.filter.lifecycle?.trim()) {
      params.push(input.filter.lifecycle.trim());
      sql += ` AND lifecycle = $${params.length}`;
    }
    if (input.filter.tag?.trim()) {
      params.push(`%"${escapeLike(input.filter.tag.trim())}"%`);
      sql += ` AND tags LIKE $${params.length}`;
    }
    if (input.filter.q?.trim()) {
      params.push(`%${escapeLike(input.filter.q.trim())}%`);
      sql += ` AND (full_name ILIKE $${params.length} OR company ILIKE $${params.length} OR email ILIKE $${params.length})`;
    }
    sql += ` ORDER BY created_at DESC LIMIT 1000`;
    const rows = await query<ContactCandidate>(sql, params);
    for (const r of rows) out.set(r.id, r);
  }
  return [...out.values()];
}

/** Phones + contact ids on the do-not-call list for this tenant. */
export async function loadDnc(dataId: string): Promise<{ phones: string[]; contactIds: string[] }> {
  const rows = await query<{ phone: string | null; contact_id: string | null }>(
    `SELECT phone, contact_id FROM contact_optouts WHERE user_id = $1 AND channel IN ('voice', 'all')`,
    [dataId]
  ).catch(() => []);
  return {
    phones: rows.map((r) => r.phone ?? "").filter(Boolean),
    contactIds: rows.map((r) => r.contact_id ?? "").filter(Boolean),
  };
}

export interface AddTargetsResult {
  added: number;
  skipped_dnc: number;
  /** Contacts without a current marketing_voice consent grant (campaign.require_consent). */
  skipped_no_consent: number;
  skipped_duplicate: number;
  skipped_invalid: number;
}

/** Build/extend the target list for a campaign from contacts and/or raw phones, honouring DNC. */
export async function addTargets(dataId: string, campaignId: string, input: AudienceInput): Promise<AddTargetsResult> {
  const result: AddTargetsResult = { added: 0, skipped_dnc: 0, skipped_no_consent: 0, skipped_duplicate: 0, skipped_invalid: 0 };
  let contacts = await resolveContacts(dataId, input);
  // Consent gate (DPDP s.6 / GDPR art. 6): unless the campaign opted out, only dial contacts with a live grant.
  const campaign = await queryOne<{ require_consent: boolean | null }>(`SELECT require_consent FROM voice_campaigns WHERE id = $1 AND user_id = $2`, [campaignId, dataId]).catch(() => null);
  if (campaign?.require_consent !== false) {
    const granted = await grantedSubset(dataId, "contact", contacts.map((c) => c.id), "marketing_voice");
    result.skipped_no_consent = contacts.filter((c) => !granted.has(c.id)).length;
    contacts = contacts.filter((c) => granted.has(c.id));
  }
  const candidates: Array<{ phone: string; contact_id: string | null; first_name: string | null; tags: string[] }> = [];
  for (const c of contacts) {
    const phone = normalizePhone(c.phone);
    if (!phone) {
      result.skipped_invalid++;
      continue;
    }
    candidates.push({ phone, contact_id: c.id, first_name: firstNameOf(c.full_name) || null, tags: parseTags(c.tags) });
  }
  for (const p of input.phones ?? []) {
    const phone = normalizePhone(p.phone);
    if (!phone) {
      result.skipped_invalid++;
      continue;
    }
    candidates.push({ phone, contact_id: null, first_name: p.first_name?.trim() || null, tags: [] });
  }

  const dnc = await loadDnc(dataId);
  const { allowed, blocked } = filterDnc(candidates, dnc);
  result.skipped_dnc = blocked.length;

  const existing = await query<{ phone: string }>(`SELECT phone FROM voice_campaign_targets WHERE campaign_id = $1 AND user_id = $2`, [campaignId, dataId]);
  const seen = new Set(existing.map((e) => e.phone));
  for (const c of allowed) {
    if (seen.has(c.phone)) {
      result.skipped_duplicate++;
      continue;
    }
    seen.add(c.phone);
    await query(
      `INSERT INTO voice_campaign_targets (user_id, campaign_id, contact_id, phone, first_name, status, attempts, created_at)
       VALUES ($1,$2,$3,$4,$5,'queued',0,NOW())`,
      [dataId, campaignId, c.contact_id, c.phone, c.first_name]
    );
    result.added++;
  }
  return result;
}

/** Record an opt-out and mark every queued target with that phone as opted out. */
export async function recordOptOut(dataId: string, input: { phone?: string | null; email?: string | null; contact_id?: string | null; channel?: string; reason?: string | null }): Promise<string> {
  const phone = input.phone ? normalizePhone(input.phone) : null;
  // Only link a contact that belongs to this workspace; a foreign id is dropped rather than stored.
  let contactId: string | null = null;
  if (input.contact_id) {
    const owned = await queryOne<{ id: string }>(`SELECT id FROM crm_contacts WHERE id = $1 AND user_id = $2`, [input.contact_id, dataId]).catch(() => null);
    contactId = owned ? input.contact_id : null;
  }
  const row = await queryOne<{ id: string }>(
    `INSERT INTO contact_optouts (user_id, contact_id, phone, email, channel, reason, created_at) VALUES ($1,$2,$3,$4,$5,$6,NOW()) RETURNING id`,
    [dataId, contactId, phone || null, input.email?.toLowerCase() ?? null, input.channel ?? "voice", input.reason ?? null]
  );
  if (phone) {
    await query(
      `UPDATE voice_campaign_targets SET status = 'opted_out' WHERE user_id = $1 AND phone = $2 AND status IN ('queued','no_answer','voicemail','failed')`,
      [dataId, phone]
    ).catch(() => undefined);
  }
  if (contactId) {
    // Tag the contact so future audiences exclude it even without the optouts table.
    const c = await queryOne<{ tags: string | null }>(`SELECT tags FROM crm_contacts WHERE id = $1 AND user_id = $2`, [contactId, dataId]).catch(() => null);
    if (c) {
      const tags = parseTags(c.tags);
      if (!tags.includes("do_not_call")) {
        tags.push("do_not_call");
        await query(`UPDATE crm_contacts SET tags = $1, updated_at = NOW() WHERE id = $2 AND user_id = $3`, [JSON.stringify(tags), contactId, dataId]).catch(() => undefined);
      }
    }
  }
  return row?.id ?? "";
}
