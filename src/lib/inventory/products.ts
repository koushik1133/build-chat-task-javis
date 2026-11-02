import { randomUUID } from "crypto";
import { z } from "zod";
import { query, queryOne } from "@/lib/dsql";
import { emitEvent } from "@/lib/events/bus";
import { likeContains } from "@/lib/like";
import { CurrencySchema } from "@/lib/money/items";
import { keysetClause, type Cursor } from "@/lib/public-api/pagination";

/**
 * Pricebook / inventory products. Money is minor units; `tax_rate_bp` is basis
 * points. Stock columns live on the row (on_hand / reserved) and every change
 * is mirrored in `stock_movements` (see ./stock.ts).
 */

export const PRODUCT_KINDS = ["product", "service", "rental"] as const;
export type ProductKind = (typeof PRODUCT_KINDS)[number];

export interface ProductRow {
  id: string;
  user_id: string;
  sku: string | null;
  name: string;
  description: string | null;
  kind: ProductKind;
  unit: string;
  unit_price_minor: string | number;
  cost_minor: string | number;
  currency: string;
  tax_rate_bp: number;
  track_stock: boolean;
  stock_on_hand: number;
  stock_reserved: number;
  reorder_point: number;
  active: boolean;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProductDTO {
  id: string;
  sku: string | null;
  name: string;
  description: string | null;
  kind: ProductKind;
  unit: string;
  unit_price_minor: number;
  cost_minor: number;
  currency: string;
  tax_rate_bp: number;
  track_stock: boolean;
  stock_on_hand: number;
  stock_reserved: number;
  /** on_hand − reserved; what can still be promised. */
  stock_available: number;
  reorder_point: number;
  low_stock: boolean;
  active: boolean;
  created_at: string;
  updated_at: string;
}

/** Pure: a tracked product is low when what's available is at or under the reorder point. */
export function isLowStock(p: { track_stock: boolean; stock_on_hand: number; stock_reserved: number; reorder_point: number }): boolean {
  if (!p.track_stock) return false;
  return availableQty(p) <= Number(p.reorder_point);
}

export function availableQty(p: { stock_on_hand: number; stock_reserved: number }): number {
  return Number(p.stock_on_hand) - Number(p.stock_reserved);
}

export function toProductDTO(r: ProductRow): ProductDTO {
  const stock_on_hand = Number(r.stock_on_hand);
  const stock_reserved = Number(r.stock_reserved);
  const reorder_point = Number(r.reorder_point);
  return {
    id: r.id,
    sku: r.sku,
    name: r.name,
    description: r.description,
    kind: r.kind,
    unit: r.unit,
    unit_price_minor: Number(r.unit_price_minor),
    cost_minor: Number(r.cost_minor),
    currency: r.currency,
    tax_rate_bp: Number(r.tax_rate_bp),
    track_stock: Boolean(r.track_stock),
    stock_on_hand,
    stock_reserved,
    stock_available: stock_on_hand - stock_reserved,
    reorder_point,
    low_stock: isLowStock({ track_stock: Boolean(r.track_stock), stock_on_hand, stock_reserved, reorder_point }),
    active: Boolean(r.active),
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

const COLS =
  "id, user_id, sku, name, description, kind, unit, unit_price_minor, cost_minor, currency, tax_rate_bp, track_stock, stock_on_hand, stock_reserved, reorder_point, active, deleted_at, created_at, updated_at";

export const ProductInputSchema = z
  .object({
    sku: z.string().trim().max(64).nullable().optional(),
    name: z.string().trim().min(1).max(200),
    description: z.string().trim().max(4000).nullable().optional(),
    kind: z.enum(PRODUCT_KINDS).default("product"),
    unit: z.string().trim().min(1).max(32).default("each"),
    unit_price_minor: z.number().int().min(0).max(1_000_000_000_000).default(0),
    cost_minor: z.number().int().min(0).max(1_000_000_000_000).default(0),
    currency: CurrencySchema.default("USD"),
    tax_rate_bp: z.number().int().min(0).max(10_000).default(0),
    track_stock: z.boolean().default(false),
    stock_on_hand: z.number().int().min(0).max(100_000_000).default(0),
    reorder_point: z.number().int().min(0).max(100_000_000).default(0),
    active: z.boolean().default(true),
  })
  .strict();
export type ProductInput = z.infer<typeof ProductInputSchema>;

export const ProductPatchSchema = ProductInputSchema.partial().strict();
export type ProductPatch = z.infer<typeof ProductPatchSchema>;

export interface ListProductsOpts {
  q?: string;
  low?: boolean;
  kind?: ProductKind;
  includeInactive?: boolean;
  limit?: number;
  /** "name" (default) or "created" (newest first, cursor-friendly). */
  order?: "name" | "created";
  cursor?: Cursor | null;
}

export async function listProducts(dataId: string, opts: ListProductsOpts = {}): Promise<ProductDTO[]> {
  const params: unknown[] = [dataId];
  let sql = `SELECT ${COLS} FROM products WHERE user_id = $1 AND deleted_at IS NULL`;
  if (!opts.includeInactive) sql += ` AND active = TRUE`;
  if (opts.kind) {
    params.push(opts.kind);
    sql += ` AND kind = $${params.length}`;
  }
  if (opts.q?.trim()) {
    params.push(likeContains(opts.q.trim().toLowerCase().slice(0, 200)));
    sql += ` AND (lower(name) LIKE $${params.length} OR lower(COALESCE(sku, '')) LIKE $${params.length} OR lower(COALESCE(description, '')) LIKE $${params.length})`;
  }
  if (opts.low) sql += ` AND track_stock = TRUE AND (stock_on_hand - stock_reserved) <= reorder_point`;
  if (opts.order === "created") sql += keysetClause(opts.cursor, params);
  params.push(Math.min(Math.max(opts.limit ?? 200, 1), 500));
  sql += opts.order === "created" ? ` ORDER BY created_at DESC, id DESC LIMIT $${params.length}` : ` ORDER BY name ASC LIMIT $${params.length}`;
  return (await query<ProductRow>(sql, params)).map(toProductDTO);
}

/** Tracked products at or below their reorder point. */
export async function listLowStock(dataId: string, limit = 100): Promise<ProductDTO[]> {
  return listProducts(dataId, { low: true, limit });
}

export async function getProduct(dataId: string, id: string): Promise<ProductDTO | null> {
  const row = await queryOne<ProductRow>(`SELECT ${COLS} FROM products WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`, [id, dataId]);
  return row ? toProductDTO(row) : null;
}

export async function getProductsByIds(dataId: string, ids: string[]): Promise<Map<string, ProductDTO>> {
  const out = new Map<string, ProductDTO>();
  const uniq = [...new Set(ids.filter(Boolean))];
  if (uniq.length === 0) return out;
  const rows = await query<ProductRow>(
    `SELECT ${COLS} FROM products WHERE user_id = $1 AND deleted_at IS NULL AND id = ANY($2::text[])`,
    [dataId, uniq]
  );
  for (const r of rows) out.set(r.id, toProductDTO(r));
  return out;
}

async function assertSkuFree(dataId: string, sku: string | null | undefined, exceptId?: string): Promise<void> {
  if (!sku) return;
  const dup = await queryOne<{ id: string }>(
    `SELECT id FROM products WHERE user_id = $1 AND sku = $2 AND deleted_at IS NULL${exceptId ? " AND id <> $3" : ""}`,
    exceptId ? [dataId, sku, exceptId] : [dataId, sku]
  );
  if (dup) throw new Error(`SKU "${sku}" is already in use`);
}

export async function createProduct(dataId: string, input: ProductInput, actorId?: string | null): Promise<ProductDTO> {
  const sku = input.sku?.trim() || null;
  await assertSkuFree(dataId, sku);
  const id = randomUUID();
  await query(
    `INSERT INTO products (id, user_id, sku, name, description, kind, unit, unit_price_minor, cost_minor, currency, tax_rate_bp,
       track_stock, stock_on_hand, stock_reserved, reorder_point, active)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 0, $14, $15)`,
    [
      id, dataId, sku, input.name, input.description ?? null, input.kind, input.unit, input.unit_price_minor, input.cost_minor,
      input.currency, input.tax_rate_bp, input.track_stock, input.track_stock ? input.stock_on_hand : 0, input.reorder_point, input.active,
    ]
  );
  if (input.track_stock && input.stock_on_hand > 0) {
    await query(
      `INSERT INTO stock_movements (id, user_id, product_id, kind, qty, ref_kind, ref_id, note, created_by)
       VALUES ($1, $2, $3, 'receive', $4, 'manual', NULL, 'Opening stock', $5)`,
      [randomUUID(), dataId, id, input.stock_on_hand, actorId ?? null]
    );
  }
  const p = await getProduct(dataId, id);
  if (!p) throw new Error("Product vanished after insert");
  void emitEvent(dataId, { type: "product.created", entity: "product", entityId: id, data: { name: p.name, sku: p.sku, kind: p.kind } });
  return p;
}

/**
 * Patch a product. `stock_on_hand` is NOT patchable here — use adjustStock so
 * the ledger stays truthful.
 */
export async function updateProduct(dataId: string, id: string, patch: ProductPatch): Promise<ProductDTO> {
  const existing = await getProduct(dataId, id);
  if (!existing) throw new Error("Product not found");
  const sets: string[] = ["updated_at = NOW()"];
  const params: unknown[] = [id, dataId];
  const push = (col: string, v: unknown) => {
    params.push(v);
    sets.push(`${col} = $${params.length}`);
  };
  if (patch.sku !== undefined) {
    const sku = patch.sku?.trim() || null;
    await assertSkuFree(dataId, sku, id);
    push("sku", sku);
  }
  if (patch.name !== undefined) push("name", patch.name);
  if (patch.description !== undefined) push("description", patch.description);
  if (patch.kind !== undefined) push("kind", patch.kind);
  if (patch.unit !== undefined) push("unit", patch.unit);
  if (patch.unit_price_minor !== undefined) push("unit_price_minor", patch.unit_price_minor);
  if (patch.cost_minor !== undefined) push("cost_minor", patch.cost_minor);
  if (patch.currency !== undefined) push("currency", patch.currency);
  if (patch.tax_rate_bp !== undefined) push("tax_rate_bp", patch.tax_rate_bp);
  if (patch.track_stock !== undefined) push("track_stock", patch.track_stock);
  if (patch.reorder_point !== undefined) push("reorder_point", patch.reorder_point);
  if (patch.active !== undefined) push("active", patch.active);
  await query(`UPDATE products SET ${sets.join(", ")} WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`, params);
  const out = await getProduct(dataId, id);
  if (!out) throw new Error("Product not found");
  return out;
}

/** Soft delete. The SKU is suffixed so it can be reused by a new product. */
export async function deleteProduct(dataId: string, id: string): Promise<boolean> {
  const existing = await getProduct(dataId, id);
  if (!existing) return false;
  await query(
    `UPDATE products SET deleted_at = NOW(), active = FALSE, updated_at = NOW(),
            sku = CASE WHEN sku IS NULL THEN NULL ELSE sku || '~deleted~' || $3 END
      WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
    [id, dataId, id.slice(0, 8)]
  );
  return true;
}
