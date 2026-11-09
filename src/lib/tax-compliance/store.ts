import { randomUUID } from "crypto";
import { z } from "zod";
import { query, queryOne } from "@/lib/dsql";
import { tableExists } from "@/lib/table-exists";
import {
  FILING_FREQUENCIES, REGIMES, REGISTRATION_TYPES, parseProfileSettings,
  type ProfileSettings, type TaxProfile,
} from "./regimes";

/** Persistence for tax_profiles / tax_exemptions / tax_filings (server only). */

interface ProfileRow {
  user_id: string; regime: string; country: string | null; state_province: string | null; registration_number: string | null;
  registration_type: string; filing_frequency: string; e_invoicing_enabled: boolean | null; settings: string | null; updated_at: string | Date;
}

function toProfile(r: ProfileRow): TaxProfile {
  return {
    user_id: r.user_id,
    regime: (REGIMES as readonly string[]).includes(r.regime) ? (r.regime as TaxProfile["regime"]) : "generic",
    country: r.country,
    state_province: r.state_province,
    registration_number: r.registration_number,
    registration_type: (REGISTRATION_TYPES as readonly string[]).includes(r.registration_type) ? (r.registration_type as TaxProfile["registration_type"]) : "regular",
    filing_frequency: (FILING_FREQUENCIES as readonly string[]).includes(r.filing_frequency) ? (r.filing_frequency as TaxProfile["filing_frequency"]) : "quarterly",
    e_invoicing_enabled: Boolean(r.e_invoicing_enabled),
    settings: parseProfileSettings(r.settings),
    updated_at: r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at),
  };
}

export async function getTaxProfile(dataId: string): Promise<TaxProfile | null> {
  if (!(await tableExists("tax_profiles"))) return null;
  const row = await queryOne<ProfileRow>(`SELECT * FROM tax_profiles WHERE user_id = $1`, [dataId]);
  return row ? toProfile(row) : null;
}

export const ProfileSettingsSchema = z
  .object({
    hsn_digits: z.union([z.literal(4), z.literal(6), z.literal(8)]).optional(),
    supply_kind: z.enum(["goods", "services"]).optional(),
    lut_zero_rated: z.boolean().optional(),
    reverse_charge_default: z.boolean().optional(),
    nexus_states: z.array(z.string().trim().toUpperCase().length(2)).max(60).optional(),
    allow_estimates: z.boolean().optional(),
    legal_name: z.string().max(200).optional(),
    address_line1: z.string().max(200).optional(),
    city: z.string().max(100).optional(),
    postal_code: z.string().max(20).optional(),
  })
  .strict();

export const TaxProfileInputSchema = z
  .object({
    regime: z.enum(REGIMES),
    country: z.string().trim().toUpperCase().max(2).nullable().optional(),
    state_province: z.string().trim().max(60).nullable().optional(),
    registration_number: z.string().trim().max(40).nullable().optional(),
    registration_type: z.enum(REGISTRATION_TYPES).default("regular"),
    filing_frequency: z.enum(FILING_FREQUENCIES).default("quarterly"),
    e_invoicing_enabled: z.boolean().default(false),
    settings: ProfileSettingsSchema.default({}),
  })
  .strict();
export type TaxProfileInput = z.infer<typeof TaxProfileInputSchema>;

export async function upsertTaxProfile(dataId: string, input: TaxProfileInput): Promise<TaxProfile> {
  const settings: ProfileSettings = input.settings;
  await query(
    `INSERT INTO tax_profiles (user_id, regime, country, state_province, registration_number, registration_type, filing_frequency, e_invoicing_enabled, settings, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
     ON CONFLICT (user_id) DO UPDATE SET regime=$2, country=$3, state_province=$4, registration_number=$5, registration_type=$6, filing_frequency=$7, e_invoicing_enabled=$8, settings=$9, updated_at=NOW()`,
    [dataId, input.regime, input.country ?? null, input.state_province ?? null, input.registration_number ?? null, input.registration_type, input.filing_frequency, input.e_invoicing_enabled, JSON.stringify(settings)]
  );
  const out = await getTaxProfile(dataId);
  if (!out) throw new Error("Tax profile vanished after save");
  return out;
}

/* ---- exemptions ---- */

export interface ExemptionDTO { id: string; contact_id: string; contact_name: string | null; jurisdiction: string; certificate_ref: string | null; expires_at: string | null; created_at: string }

export const ExemptionInputSchema = z
  .object({
    contact_id: z.string().min(1).max(100),
    jurisdiction: z.string().trim().toUpperCase().min(2).max(10),
    certificate_ref: z.string().trim().max(120).nullable().optional(),
    expires_at: z.string().max(40).nullable().optional(),
  })
  .strict();

export async function listExemptions(dataId: string, contactId?: string): Promise<ExemptionDTO[]> {
  if (!(await tableExists("tax_exemptions"))) return [];
  const params: unknown[] = [dataId];
  let where = "e.user_id = $1";
  if (contactId) {
    params.push(contactId);
    where += " AND e.contact_id = $2";
  }
  const rows = await query<{ id: string; contact_id: string; contact_name: string | null; jurisdiction: string; certificate_ref: string | null; expires_at: string | Date | null; created_at: string | Date }>(
    `SELECT e.id, e.contact_id, c.full_name AS contact_name, e.jurisdiction, e.certificate_ref, e.expires_at, e.created_at
       FROM tax_exemptions e LEFT JOIN crm_contacts c ON c.id = e.contact_id AND c.user_id = e.user_id WHERE ${where} ORDER BY e.created_at DESC LIMIT 500`,
    params
  );
  const iso = (v: string | Date | null) => (v === null ? null : v instanceof Date ? v.toISOString() : String(v));
  return rows.map((r) => ({ ...r, expires_at: iso(r.expires_at), created_at: iso(r.created_at) ?? "" }));
}

export async function createExemption(dataId: string, input: z.infer<typeof ExemptionInputSchema>): Promise<ExemptionDTO> {
  const c = await queryOne(`SELECT id FROM crm_contacts WHERE id = $1 AND user_id = $2`, [input.contact_id, dataId]);
  if (!c) throw new Error("Contact not found");
  const id = randomUUID();
  await query(`INSERT INTO tax_exemptions (id, user_id, contact_id, jurisdiction, certificate_ref, expires_at) VALUES ($1,$2,$3,$4,$5,$6)`, [id, dataId, input.contact_id, input.jurisdiction, input.certificate_ref ?? null, input.expires_at ?? null]);
  const all = await listExemptions(dataId, input.contact_id);
  const out = all.find((e) => e.id === id);
  if (!out) throw new Error("Exemption vanished after insert");
  return out;
}

export async function deleteExemption(dataId: string, id: string): Promise<boolean> {
  const rows = await query<{ id: string }>(`DELETE FROM tax_exemptions WHERE id = $1 AND user_id = $2 RETURNING id`, [id, dataId]);
  return rows.length > 0;
}

/* ---- filings ---- */

export const FILING_STATUSES = ["draft", "prepared", "filed", "void"] as const;
export type FilingStatus = (typeof FILING_STATUSES)[number];
export interface FilingDTO { id: string; regime: string; period_start: string; period_end: string; status: FilingStatus; totals: Record<string, unknown>; report_hash: string | null; filed_ref: string | null; filed_at: string | null; notes: string | null; created_at: string }

interface FilingRow { id: string; regime: string; period_start: string | Date; period_end: string | Date; status: string; totals: string | null; report_hash: string | null; filed_ref: string | null; filed_at: string | Date | null; notes: string | null; created_at: string | Date }
const iso = (v: string | Date | null): string | null => (v === null ? null : v instanceof Date ? v.toISOString() : String(v));
function toFiling(r: FilingRow): FilingDTO {
  let totals: Record<string, unknown> = {};
  try {
    const v: unknown = JSON.parse(r.totals ?? "{}");
    if (v && typeof v === "object") totals = v as Record<string, unknown>;
  } catch { /* keep {} */ }
  return { id: r.id, regime: r.regime, period_start: iso(r.period_start) ?? "", period_end: iso(r.period_end) ?? "", status: r.status as FilingStatus, totals, report_hash: r.report_hash, filed_ref: r.filed_ref, filed_at: iso(r.filed_at), notes: r.notes, created_at: iso(r.created_at) ?? "" };
}

export async function listFilings(dataId: string, limit = 100): Promise<FilingDTO[]> {
  if (!(await tableExists("tax_filings"))) return [];
  const rows = await query<FilingRow>(`SELECT * FROM tax_filings WHERE user_id = $1 AND (notes IS NULL OR notes NOT LIKE 'reminder:%') ORDER BY period_start DESC, created_at DESC LIMIT $2`, [dataId, Math.min(limit, 500)]);
  return rows.map(toFiling);
}

export async function getFiling(dataId: string, id: string): Promise<FilingDTO | null> {
  const r = await queryOne<FilingRow>(`SELECT * FROM tax_filings WHERE id = $1 AND user_id = $2`, [id, dataId]);
  return r ? toFiling(r) : null;
}

export async function prepareFiling(dataId: string, input: { regime: string; period_start: string; period_end: string; totals: Record<string, unknown>; report_hash: string; notes?: string | null }): Promise<FilingDTO> {
  const dup = await queryOne<FilingRow>(
    `SELECT * FROM tax_filings WHERE user_id = $1 AND regime = $2 AND period_start = $3 AND period_end = $4 AND status IN ('draft','prepared') ORDER BY created_at DESC LIMIT 1`,
    [dataId, input.regime, input.period_start, input.period_end]
  );
  if (dup) {
    await query(`UPDATE tax_filings SET status = 'prepared', totals = $3, report_hash = $4, notes = COALESCE($5, notes) WHERE id = $1 AND user_id = $2`, [dup.id, dataId, JSON.stringify(input.totals), input.report_hash, input.notes ?? null]);
    const out = await getFiling(dataId, dup.id);
    if (out) return out;
  }
  const id = randomUUID();
  await query(
    `INSERT INTO tax_filings (id, user_id, regime, period_start, period_end, status, totals, report_hash, notes) VALUES ($1,$2,$3,$4,$5,'prepared',$6,$7,$8)`,
    [id, dataId, input.regime, input.period_start, input.period_end, JSON.stringify(input.totals), input.report_hash, input.notes ?? null]
  );
  const out = await getFiling(dataId, id);
  if (!out) throw new Error("Filing vanished after insert");
  return out;
}

export async function markFiled(dataId: string, id: string, filedRef: string): Promise<FilingDTO> {
  const f = await getFiling(dataId, id);
  if (!f) throw new Error("Filing not found");
  if (f.status === "void") throw new Error("Filing is void");
  await query(`UPDATE tax_filings SET status = 'filed', filed_ref = $3, filed_at = NOW() WHERE id = $1 AND user_id = $2`, [id, dataId, filedRef]);
  const out = await getFiling(dataId, id);
  if (!out) throw new Error("Filing not found");
  return out;
}

export async function voidFiling(dataId: string, id: string): Promise<FilingDTO> {
  await query(`UPDATE tax_filings SET status = 'void' WHERE id = $1 AND user_id = $2 AND status <> 'filed'`, [id, dataId]);
  const out = await getFiling(dataId, id);
  if (!out) throw new Error("Filing not found");
  return out;
}

/* ---- per-contact / per-product tax fields ---- */

export const ContactTaxSchema = z
  .object({
    tax_number: z.string().trim().max(40).nullable().optional(),
    tax_country: z.string().trim().toUpperCase().max(2).nullable().optional(),
    tax_state: z.string().trim().max(60).nullable().optional(),
    tax_registration_type: z.enum(["b2b", "b2c", "exempt"]).nullable().optional(),
  })
  .strict();
export type ContactTaxInput = z.infer<typeof ContactTaxSchema>;

export async function getContactTaxFields(dataId: string, contactId: string): Promise<Required<ContactTaxInput> | null> {
  const r = await queryOne<{ tax_number: string | null; tax_country: string | null; tax_state: string | null; tax_registration_type: string | null }>(
    `SELECT tax_number, tax_country, tax_state, tax_registration_type FROM crm_contacts WHERE id = $1 AND user_id = $2`,
    [contactId, dataId]
  );
  return r ? { ...r, tax_registration_type: (r.tax_registration_type as "b2b" | "b2c" | "exempt" | null) ?? null } : null;
}

export async function setContactTaxFields(dataId: string, contactId: string, input: ContactTaxInput): Promise<boolean> {
  const sets: string[] = [];
  const params: unknown[] = [contactId, dataId];
  for (const k of ["tax_number", "tax_country", "tax_state", "tax_registration_type"] as const) {
    if (input[k] !== undefined) {
      params.push(input[k] || null);
      sets.push(`${k} = $${params.length}`);
    }
  }
  if (sets.length === 0) return (await getContactTaxFields(dataId, contactId)) !== null;
  const rows = await query<{ id: string }>(`UPDATE crm_contacts SET ${sets.join(", ")} WHERE id = $1 AND user_id = $2 RETURNING id`, params);
  return rows.length > 0;
}

export const ProductTaxSchema = z
  .object({ hsn_sac_code: z.string().trim().regex(/^\d{4,8}$/, "HSN/SAC must be 4-8 digits").nullable().optional(), tax_category: z.string().trim().max(60).nullable().optional() })
  .strict();
export type ProductTaxInput = z.infer<typeof ProductTaxSchema>;

export async function getProductTaxFields(dataId: string, productId: string): Promise<Required<ProductTaxInput> | null> {
  return (await queryOne<{ hsn_sac_code: string | null; tax_category: string | null }>(`SELECT hsn_sac_code, tax_category FROM products WHERE id = $1 AND user_id = $2`, [productId, dataId])) ?? null;
}

export async function setProductTaxFields(dataId: string, productId: string, input: ProductTaxInput): Promise<boolean> {
  const sets: string[] = [];
  const params: unknown[] = [productId, dataId];
  for (const k of ["hsn_sac_code", "tax_category"] as const) {
    if (input[k] !== undefined) {
      params.push(input[k] || null);
      sets.push(`${k} = $${params.length}`);
    }
  }
  if (sets.length === 0) return (await getProductTaxFields(dataId, productId)) !== null;
  const rows = await query<{ id: string }>(`UPDATE products SET ${sets.join(", ")} WHERE id = $1 AND user_id = $2 RETURNING id`, params);
  return rows.length > 0;
}
