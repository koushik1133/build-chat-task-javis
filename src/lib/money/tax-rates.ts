import { randomUUID } from "crypto";
import { z } from "zod";
import { query, queryOne } from "@/lib/dsql";
import { tableExists } from "@/lib/table-exists";
import { TAX_KINDS, computeTotals as computeTaxTotals, type TaxRateLike, type TaxTotals } from "./tax";
import { getBillingSettings } from "./settings";
import type { LineItem } from "./items";

/** Org tax-rate catalogue + the server-side "resolve totals for a document" glue. */

export interface TaxRateDTO extends TaxRateLike {
  id: string;
  name: string;
  rate_bp: number;
  kind: string;
  jurisdiction: string | null;
  compound: boolean;
  is_default: boolean;
  active: boolean;
  created_at: string;
}

interface Row {
  id: string;
  name: string;
  rate_bp: number | string;
  kind: string;
  jurisdiction: string | null;
  compound: boolean | null;
  is_default: boolean | null;
  active: boolean | null;
  created_at: string | Date;
}

const COLS = "id, name, rate_bp, kind, jurisdiction, compound, is_default, active, created_at";

function toDTO(r: Row): TaxRateDTO {
  return {
    id: r.id,
    name: r.name,
    rate_bp: Number(r.rate_bp),
    kind: r.kind,
    jurisdiction: r.jurisdiction,
    compound: Boolean(r.compound),
    is_default: Boolean(r.is_default),
    active: r.active !== false,
    created_at: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
  };
}

export const TaxRateInputSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    rate_bp: z.number().int().min(0).max(10_000),
    kind: z.enum(TAX_KINDS as [string, ...string[]]).default("other"),
    jurisdiction: z.string().trim().max(80).nullable().optional(),
    compound: z.boolean().optional(),
    is_default: z.boolean().optional(),
    active: z.boolean().optional(),
  })
  .strict();
export type TaxRateInput = z.infer<typeof TaxRateInputSchema>;
export const TaxRatePatchSchema = TaxRateInputSchema.partial().strict();

export async function listTaxRates(dataId: string, opts: { includeInactive?: boolean } = {}): Promise<TaxRateDTO[]> {
  if (!(await tableExists("tax_rates"))) return [];
  const rows = await query<Row>(
    `SELECT ${COLS} FROM tax_rates WHERE user_id = $1${opts.includeInactive ? "" : " AND active = TRUE"} ORDER BY is_default DESC, created_at ASC`,
    [dataId]
  );
  return rows.map(toDTO);
}

export async function getTaxRate(dataId: string, id: string): Promise<TaxRateDTO | null> {
  const row = await queryOne<Row>(`SELECT ${COLS} FROM tax_rates WHERE id = $1 AND user_id = $2`, [id, dataId]);
  return row ? toDTO(row) : null;
}

export async function createTaxRate(dataId: string, input: TaxRateInput): Promise<TaxRateDTO> {
  const id = randomUUID();
  if (input.is_default) await query(`UPDATE tax_rates SET is_default = FALSE WHERE user_id = $1 AND is_default = TRUE`, [dataId]);
  await query(
    `INSERT INTO tax_rates (id, user_id, name, rate_bp, kind, jurisdiction, compound, is_default, active)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [id, dataId, input.name, input.rate_bp, input.kind ?? "other", input.jurisdiction ?? null, input.compound === true, input.is_default === true, input.active !== false]
  );
  const out = await getTaxRate(dataId, id);
  if (!out) throw new Error("Tax rate vanished after insert");
  return out;
}

export async function updateTaxRate(dataId: string, id: string, patch: z.infer<typeof TaxRatePatchSchema>): Promise<TaxRateDTO> {
  const cur = await getTaxRate(dataId, id);
  if (!cur) throw new Error("Tax rate not found");
  if (patch.is_default) await query(`UPDATE tax_rates SET is_default = FALSE WHERE user_id = $1 AND is_default = TRUE AND id <> $2`, [dataId, id]);
  const sets: string[] = [];
  const params: unknown[] = [id, dataId];
  const push = (col: string, v: unknown) => {
    params.push(v);
    sets.push(`${col} = $${params.length}`);
  };
  if (patch.name !== undefined) push("name", patch.name);
  if (patch.rate_bp !== undefined) push("rate_bp", patch.rate_bp);
  if (patch.kind !== undefined) push("kind", patch.kind);
  if (patch.jurisdiction !== undefined) push("jurisdiction", patch.jurisdiction);
  if (patch.compound !== undefined) push("compound", patch.compound);
  if (patch.is_default !== undefined) push("is_default", patch.is_default);
  if (patch.active !== undefined) push("active", patch.active);
  if (sets.length > 0) await query(`UPDATE tax_rates SET ${sets.join(", ")} WHERE id = $1 AND user_id = $2`, params);
  const out = await getTaxRate(dataId, id);
  if (!out) throw new Error("Tax rate not found");
  return out;
}

/** Soft delete: deactivate so historical documents keep resolving the rate. */
export async function deleteTaxRate(dataId: string, id: string): Promise<boolean> {
  const rows = await query<{ id: string }>(`UPDATE tax_rates SET active = FALSE, is_default = FALSE WHERE id = $1 AND user_id = $2 RETURNING id`, [id, dataId]);
  return rows.length > 0;
}

export interface DocumentTaxOptions {
  contactId?: string | null;
  shipTo?: { country?: string | null; state?: string | null; postal_code?: string | null } | null;
  docDate?: Date;
  reverseCharge?: boolean;
}

export type DocumentTotals = TaxTotals & { compliance?: import("@/lib/tax-compliance/resolver").ComplianceMeta };

/**
 * Totals for a document owned by `dataId`: resolves catalogue rates (incl.
 * inactive ones referenced by old documents) and applies the org's inclusive /
 * rounding preferences. Falls back to inline basis points when the table is missing.
 *
 * Optional compliance hook: only when the org has a tax profile (Phase 11,
 * src/lib/tax-compliance) are lines re-pointed at regime component rates
 * (CGST/SGST/IGST, destination VAT, ...). Without a profile this is exactly the
 * historic behaviour.
 */
export async function resolveDocumentTotals(dataId: string, items: readonly LineItem[], opts: DocumentTaxOptions = {}): Promise<DocumentTotals> {
  const [rates, settings] = await Promise.all([listTaxRates(dataId, { includeInactive: true }).catch(() => [] as TaxRateDTO[]), getBillingSettings(dataId)]);
  const base = { inclusive: settings.prices_include_tax, rounding: settings.tax_rounding };
  if (await tableExists("tax_profiles")) {
    try {
      const { resolveDocumentTax } = await import("@/lib/tax-compliance/document");
      const r = await resolveDocumentTax(dataId, items, opts);
      if (r) return { ...computeTaxTotals(r.items, r.rates, base), compliance: r.meta };
    } catch {
      /* compliance is best-effort: fall through to the plain engine */
    }
  }
  return computeTaxTotals(items, rates, base);
}
