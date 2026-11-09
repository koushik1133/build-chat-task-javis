import { randomUUID } from "crypto";
import { z } from "zod";
import { query, queryOne } from "@/lib/dsql";
import { likeContains } from "@/lib/like";
import { CurrencySchema } from "@/lib/money/items";
import { keysetClause, keysetOrder, type Cursor } from "@/lib/public-api/pagination";

/** Suppliers (vendors): who we buy from. Soft-deleted; `address` is JSON TEXT or free text. */

export interface SupplierRow {
  id: string;
  user_id: string;
  name: string;
  email: string | null;
  phone: string | null;
  tax_number: string | null;
  address: string | null;
  payment_terms_days: number | string;
  currency: string;
  notes: string | null;
  active: boolean;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface SupplierDTO {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  tax_number: string | null;
  address: string | null;
  payment_terms_days: number;
  currency: string;
  notes: string | null;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export function toSupplierDTO(r: SupplierRow): SupplierDTO {
  return {
    id: r.id,
    name: r.name,
    email: r.email,
    phone: r.phone,
    tax_number: r.tax_number,
    address: r.address,
    payment_terms_days: Number(r.payment_terms_days),
    currency: r.currency,
    notes: r.notes,
    active: Boolean(r.active),
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

const COLS = "id, user_id, name, email, phone, tax_number, address, payment_terms_days, currency, notes, active, deleted_at, created_at, updated_at";

const AddressSchema = z.union([
  z.string().trim().max(1000),
  z
    .object({
      line1: z.string().trim().max(200).optional(),
      line2: z.string().trim().max(200).optional(),
      city: z.string().trim().max(120).optional(),
      region: z.string().trim().max(120).optional(),
      postal_code: z.string().trim().max(40).optional(),
      country: z.string().trim().max(80).optional(),
    })
    .strict(),
]);

export const SupplierInputSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    email: z.string().trim().email().max(320).nullable().optional(),
    phone: z.string().trim().max(40).nullable().optional(),
    tax_number: z.string().trim().max(64).nullable().optional(),
    address: AddressSchema.nullable().optional(),
    payment_terms_days: z.number().int().min(0).max(365).default(30),
    currency: CurrencySchema.default("USD"),
    notes: z.string().trim().max(4000).nullable().optional(),
    active: z.boolean().default(true),
  })
  .strict();
export type SupplierInput = z.infer<typeof SupplierInputSchema>;
export const SupplierPatchSchema = SupplierInputSchema.partial().strict();
export type SupplierPatch = z.infer<typeof SupplierPatchSchema>;

function addressText(v: SupplierInput["address"]): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return v.trim() || null;
  return Object.values(v).some((x) => x && x.trim()) ? JSON.stringify(v) : null;
}

export interface ListSuppliersOpts {
  q?: string | null;
  includeInactive?: boolean;
  limit?: number;
  order?: "name" | "created";
  cursor?: Cursor | null;
}

export async function listSuppliers(dataId: string, opts: ListSuppliersOpts = {}): Promise<SupplierDTO[]> {
  const params: unknown[] = [dataId];
  let sql = `SELECT ${COLS} FROM suppliers WHERE user_id = $1 AND deleted_at IS NULL`;
  if (!opts.includeInactive) sql += ` AND active = TRUE`;
  if (opts.q?.trim()) {
    params.push(likeContains(opts.q.trim().toLowerCase().slice(0, 200)));
    sql += ` AND (lower(name) LIKE $${params.length} OR lower(COALESCE(email, '')) LIKE $${params.length})`;
  }
  if (opts.order === "created") sql += keysetClause(opts.cursor, params);
  params.push(Math.min(Math.max(opts.limit ?? 200, 1), 500));
  sql += opts.order === "created" ? ` ORDER BY ${keysetOrder()} LIMIT $${params.length}` : ` ORDER BY name ASC LIMIT $${params.length}`;
  return (await query<SupplierRow>(sql, params)).map(toSupplierDTO);
}

export async function getSupplier(dataId: string, id: string): Promise<SupplierDTO | null> {
  const row = await queryOne<SupplierRow>(`SELECT ${COLS} FROM suppliers WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`, [id, dataId]);
  return row ? toSupplierDTO(row) : null;
}

export async function getSuppliersByIds(dataId: string, ids: string[]): Promise<Map<string, SupplierDTO>> {
  const out = new Map<string, SupplierDTO>();
  const uniq = [...new Set(ids.filter(Boolean))];
  if (uniq.length === 0) return out;
  const rows = await query<SupplierRow>(`SELECT ${COLS} FROM suppliers WHERE user_id = $1 AND deleted_at IS NULL AND id = ANY($2::text[])`, [dataId, uniq]);
  for (const r of rows) out.set(r.id, toSupplierDTO(r));
  return out;
}

export async function createSupplier(dataId: string, input: SupplierInput): Promise<SupplierDTO> {
  const id = randomUUID();
  await query(
    `INSERT INTO suppliers (id, user_id, name, email, phone, tax_number, address, payment_terms_days, currency, notes, active)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [id, dataId, input.name, input.email ?? null, input.phone ?? null, input.tax_number ?? null, addressText(input.address), input.payment_terms_days, input.currency, input.notes ?? null, input.active]
  );
  const s = await getSupplier(dataId, id);
  if (!s) throw new Error("Supplier vanished after insert");
  return s;
}

export async function updateSupplier(dataId: string, id: string, patch: SupplierPatch): Promise<SupplierDTO> {
  const existing = await getSupplier(dataId, id);
  if (!existing) throw new Error("Supplier not found");
  const sets: string[] = ["updated_at = NOW()"];
  const params: unknown[] = [id, dataId];
  const push = (col: string, v: unknown) => {
    params.push(v);
    sets.push(`${col} = $${params.length}`);
  };
  if (patch.name !== undefined) push("name", patch.name);
  if (patch.email !== undefined) push("email", patch.email);
  if (patch.phone !== undefined) push("phone", patch.phone);
  if (patch.tax_number !== undefined) push("tax_number", patch.tax_number);
  if (patch.address !== undefined) push("address", addressText(patch.address));
  if (patch.payment_terms_days !== undefined) push("payment_terms_days", patch.payment_terms_days);
  if (patch.currency !== undefined) push("currency", patch.currency);
  if (patch.notes !== undefined) push("notes", patch.notes);
  if (patch.active !== undefined) push("active", patch.active);
  await query(`UPDATE suppliers SET ${sets.join(", ")} WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`, params);
  const out = await getSupplier(dataId, id);
  if (!out) throw new Error("Supplier not found");
  return out;
}

/** Soft delete; purchase orders and bills keep their supplier_id for history. */
export async function deleteSupplier(dataId: string, id: string): Promise<boolean> {
  const existing = await getSupplier(dataId, id);
  if (!existing) return false;
  await query(`UPDATE suppliers SET deleted_at = NOW(), active = FALSE, updated_at = NOW() WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`, [id, dataId]);
  return true;
}
