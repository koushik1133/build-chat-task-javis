import { randomUUID } from "crypto";
import { query, queryOne } from "@/lib/dsql";
import { escapeLike } from "@/lib/like";
import { grantedSubset } from "@/lib/privacy/consent";
import { AudienceDefinitionSchema, CONSENT_PURPOSE_FOR_CHANNEL, parseAudienceDefinition, type AudienceDefinition, type MarketingSendChannel } from "./types";

/**
 * Audiences: a saved filter over crm_contacts. `buildAudienceQuery` is a pure
 * SQL builder — every user value is a bound parameter and every identifier is
 * a literal from this file, so a definition can never inject SQL.
 */

export interface AudienceRow {
  id: string;
  user_id: string;
  name: string;
  definition: string;
  is_dynamic: boolean;
  size_cache: number | null;
  created_at: string;
  updated_at: string;
}

export interface AudienceContact {
  id: string;
  full_name: string;
  email: string | null;
  phone: string | null;
  company: string | null;
  lifecycle: string;
}

const COLS = `id, user_id, name, definition, is_dynamic, size_cache, created_at, updated_at`;
export const CONTACT_COLS = `c.id, c.full_name, c.email, c.phone, c.company, c.lifecycle`;

export interface BuiltQuery {
  /** WHERE fragment (without the leading WHERE), referencing alias `c`. */
  where: string;
  params: unknown[];
}

/**
 * Build the WHERE clause for a definition. `params[0]` is always the data id.
 * Pure; unit-tested with fuzzed definitions.
 */
export function buildAudienceWhere(dataId: string, raw: AudienceDefinition): BuiltQuery {
  const def = AudienceDefinitionSchema.parse(raw);
  const params: unknown[] = [dataId];
  const where: string[] = ["c.user_id = $1", "c.deleted_at IS NULL"];
  const p = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  if (def.lifecycle?.length) where.push(`c.lifecycle = ANY(${p(def.lifecycle)})`);
  for (const tag of def.tags ?? []) where.push(`c.tags LIKE ${p(`%"${escapeLike(tag)}"%`)}`);
  if (def.q) {
    const like = p(`%${escapeLike(def.q)}%`);
    where.push(`(c.full_name ILIKE ${like} OR COALESCE(c.company, '') ILIKE ${like} OR COALESCE(c.email, '') ILIKE ${like})`);
  }
  if (def.has_email) where.push(`c.email IS NOT NULL AND c.email <> ''`);
  if (def.has_phone) where.push(`c.phone IS NOT NULL AND c.phone <> ''`);
  if (def.last_activity_days) where.push(`COALESCE(c.last_contact, c.updated_at, c.created_at) >= NOW() - (${p(String(def.last_activity_days))} || ' days')::interval`);
  if (def.consent_purpose) {
    const purpose = p(def.consent_purpose);
    where.push(
      `EXISTS (SELECT 1 FROM consent_records cr WHERE cr.user_id = c.user_id AND cr.subject_kind = 'contact' AND cr.subject_id = c.id AND cr.purpose = ${purpose} AND cr.status = 'granted'
         AND NOT EXISTS (SELECT 1 FROM consent_records cr2 WHERE cr2.user_id = cr.user_id AND cr2.subject_kind = 'contact' AND cr2.subject_id = cr.subject_id AND cr2.purpose = cr.purpose AND (cr2.occurred_at > cr.occurred_at OR (cr2.occurred_at = cr.occurred_at AND cr2.created_at > cr.created_at))))`
    );
  }
  if (def.record_type) {
    const type = p(def.record_type);
    const stage = def.stage ? ` AND r.stage = ${p(def.stage)}` : "";
    where.push(`EXISTS (SELECT 1 FROM records r JOIN record_types rt ON rt.id = r.type_id WHERE r.user_id = c.user_id AND r.contact_id = c.id AND r.deleted_at IS NULL AND (rt.slug = ${type} OR rt.id = ${type})${stage})`);
  }
  return { where: where.join(" AND "), params };
}

export async function resolveAudience(dataId: string, def: AudienceDefinition, opts: { limit?: number; offset?: number } = {}): Promise<AudienceContact[]> {
  const built = buildAudienceWhere(dataId, def);
  const limit = Math.max(1, Math.min(5000, opts.limit ?? 500));
  const params = [...built.params, limit, Math.max(0, opts.offset ?? 0)];
  return query<AudienceContact>(
    `SELECT ${CONTACT_COLS} FROM crm_contacts c WHERE ${built.where} ORDER BY c.created_at ASC, c.id ASC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
}

/** Ids only (for consent checks / enrollment sweeps). */
export async function resolveAudienceIds(dataId: string, def: AudienceDefinition, limit = 5000): Promise<string[]> {
  const built = buildAudienceWhere(dataId, def);
  const params = [...built.params, Math.max(1, Math.min(20_000, limit))];
  const rows = await query<{ id: string }>(`SELECT c.id FROM crm_contacts c WHERE ${built.where} ORDER BY c.created_at ASC, c.id ASC LIMIT $${params.length}`, params);
  return rows.map((r) => r.id);
}

export async function countAudience(dataId: string, def: AudienceDefinition): Promise<number> {
  const built = buildAudienceWhere(dataId, def);
  const row = await queryOne<{ n: string }>(`SELECT COUNT(*)::text AS n FROM crm_contacts c WHERE ${built.where}`, built.params);
  return parseInt(row?.n ?? "0", 10);
}

/**
 * Contacts in the audience that may actually receive marketing on `channel`:
 * current consent grant, a usable address, not opted out, not a tombstone.
 * Capped at 5000 contacts per evaluation.
 */
export async function eligibleCount(dataId: string, def: AudienceDefinition, channel: MarketingSendChannel): Promise<{ total: number; eligible: number }> {
  const built = buildAudienceWhere(dataId, { ...def, ...(channel === "email" ? { has_email: true } : { has_phone: true }) });
  const rows = await query<{ id: string; email: string | null; phone: string | null }>(`SELECT c.id, c.email, c.phone FROM crm_contacts c WHERE ${built.where} LIMIT 5000`, built.params);
  const total = await countAudience(dataId, def);
  if (rows.length === 0) return { total, eligible: 0 };
  const granted = await grantedSubset(dataId, "contact", rows.map((r) => r.id), CONSENT_PURPOSE_FOR_CHANNEL[channel]);
  if (granted.size === 0) return { total, eligible: 0 };
  const candidates = rows.filter((r) => granted.has(r.id));
  const optChannels = channel === "sms" ? ["sms", "all"] : ["email", "all"];
  const opted = await query<{ contact_id: string | null; email: string | null; phone: string | null }>(
    `SELECT contact_id, email, phone FROM contact_optouts WHERE user_id = $1 AND channel = ANY($2) AND (contact_id = ANY($3) OR lower(email) = ANY($4) OR phone = ANY($5))`,
    [dataId, optChannels, candidates.map((c) => c.id), candidates.map((c) => (c.email ?? "").toLowerCase()).filter(Boolean), candidates.map((c) => c.phone ?? "").filter(Boolean)]
  ).catch(() => []);
  const optIds = new Set(opted.map((o) => o.contact_id).filter(Boolean) as string[]);
  const optEmails = new Set(opted.map((o) => (o.email ?? "").toLowerCase()).filter(Boolean));
  const optPhones = new Set(opted.map((o) => o.phone ?? "").filter(Boolean));
  const eligible = candidates.filter((c) => !optIds.has(c.id) && !(c.email && optEmails.has(c.email.toLowerCase())) && !(c.phone && optPhones.has(c.phone))).length;
  return { total, eligible };
}

/* ---------- CRUD ---------- */

export async function listAudiences(dataId: string): Promise<AudienceRow[]> {
  return query<AudienceRow>(`SELECT ${COLS} FROM audiences WHERE user_id = $1 ORDER BY created_at DESC LIMIT 200`, [dataId]);
}

export async function getAudience(dataId: string, id: string): Promise<AudienceRow | null> {
  return queryOne<AudienceRow>(`SELECT ${COLS} FROM audiences WHERE user_id = $1 AND id = $2`, [dataId, id]);
}

export async function createAudience(dataId: string, input: { name: string; definition: AudienceDefinition; is_dynamic?: boolean }): Promise<AudienceRow> {
  const def = AudienceDefinitionSchema.parse(input.definition);
  const size = await countAudience(dataId, def).catch(() => null);
  const row = await queryOne<AudienceRow>(
    `INSERT INTO audiences (id, user_id, name, definition, is_dynamic, size_cache, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW()) RETURNING ${COLS}`,
    [randomUUID(), dataId, input.name.trim(), JSON.stringify(def), input.is_dynamic ?? true, size]
  );
  if (!row) throw new Error("audience insert returned no row");
  return row;
}

export async function updateAudience(dataId: string, id: string, patch: { name?: string; definition?: AudienceDefinition; is_dynamic?: boolean }): Promise<AudienceRow | null> {
  const current = await getAudience(dataId, id);
  if (!current) return null;
  const def = patch.definition ? AudienceDefinitionSchema.parse(patch.definition) : parseAudienceDefinition(current.definition);
  const size = await countAudience(dataId, def).catch(() => current.size_cache);
  return queryOne<AudienceRow>(
    `UPDATE audiences SET name = $3, definition = $4, is_dynamic = $5, size_cache = $6, updated_at = NOW() WHERE user_id = $1 AND id = $2 RETURNING ${COLS}`,
    [dataId, id, (patch.name ?? current.name).trim(), JSON.stringify(def), patch.is_dynamic ?? current.is_dynamic, size]
  );
}

export async function deleteAudience(dataId: string, id: string): Promise<boolean> {
  const row = await queryOne<{ id: string }>(`DELETE FROM audiences WHERE user_id = $1 AND id = $2 RETURNING id`, [dataId, id]);
  return Boolean(row);
}

/** Refresh `size_cache` for one audience (called after launches / sweeps). */
export async function refreshAudienceSize(dataId: string, id: string): Promise<number | null> {
  const row = await getAudience(dataId, id);
  if (!row) return null;
  const n = await countAudience(dataId, parseAudienceDefinition(row.definition));
  await query(`UPDATE audiences SET size_cache = $3, updated_at = NOW() WHERE user_id = $1 AND id = $2`, [dataId, id, n]).catch(() => undefined);
  return n;
}
