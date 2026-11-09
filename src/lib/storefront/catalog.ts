import { randomUUID } from "crypto";
import { z } from "zod";
import { query, queryOne } from "@/lib/dsql";
import { tableExists } from "@/lib/table-exists";
import { isSafeAssetUrl } from "@/lib/branding";
import { type ProductDTO, type ProductRow, toProductDTO } from "@/lib/inventory/products";

/**
 * Which pricebook products the storefront lists, and the public catalog view.
 * Images are either an absolute URL or `attachment:<id>` (an attachment on the
 * product with visibility "portal"), served publicly via /api/shop/<org>/image/<id>.
 */

export interface StorefrontProductDTO extends ProductDTO {
  visible: boolean;
  sort: number;
  description_md: string | null;
  image_url: string | null;
}

export interface CatalogItem {
  id: string;
  sku: string | null;
  name: string;
  description: string | null;
  unit: string;
  price_minor: number;
  currency: string;
  tax_rate_bp: number;
  /** null = untracked (always available). */
  stock_available: number | null;
  in_stock: boolean;
  low_stock: boolean;
  image_url: string | null;
}

type JoinedRow = ProductRow & { sp_visible: boolean | null; sp_sort: number | string | null; sp_description_md: string | null; sp_image_url: string | null };

const PRODUCT_COLS =
  "p.id, p.user_id, p.sku, p.name, p.description, p.kind, p.unit, p.unit_price_minor, p.cost_minor, p.currency, p.tax_rate_bp, p.track_stock, p.stock_on_hand, p.stock_reserved, p.reorder_point, p.preferred_supplier_id, p.last_cost_minor, p.active, p.deleted_at, p.created_at, p.updated_at";

const SELECT = `
  SELECT ${PRODUCT_COLS}, sp.visible AS sp_visible, sp.sort AS sp_sort, sp.description_md AS sp_description_md, sp.image_url AS sp_image_url
    FROM products p LEFT JOIN storefront_products sp ON sp.product_id = p.id AND sp.user_id = p.user_id`;

function toStorefrontProduct(r: JoinedRow): StorefrontProductDTO {
  return {
    ...toProductDTO(r),
    visible: Boolean(r.sp_visible),
    sort: Number(r.sp_sort ?? 0),
    description_md: r.sp_description_md ?? null,
    image_url: r.sp_image_url ?? null,
  };
}

/** Staff: every active product with its storefront flags (visible first, then sort, then name). */
export async function listStorefrontProducts(dataId: string): Promise<StorefrontProductDTO[]> {
  if (!(await tableExists("storefront_products"))) return [];
  const rows = await query<JoinedRow>(
    `${SELECT} WHERE p.user_id = $1 AND p.deleted_at IS NULL AND p.active = TRUE ORDER BY COALESCE(sp.visible, FALSE) DESC, COALESCE(sp.sort, 0) ASC, p.name ASC LIMIT 500`,
    [dataId]
  );
  return rows.map(toStorefrontProduct);
}

export const StorefrontProductPatchSchema = z
  .object({
    product_id: z.string().min(1).max(100),
    visible: z.boolean().optional(),
    sort: z.number().int().min(-100_000).max(100_000).optional(),
    description_md: z.string().max(10_000).nullable().optional(),
    /** Absolute http(s) URL, `attachment:<id>` or null to clear. */
    image_url: z.string().max(2000).nullable().optional(),
  })
  .strict();
export type StorefrontProductPatch = z.infer<typeof StorefrontProductPatchSchema>;

export const ATTACHMENT_IMAGE_RE = /^attachment:([A-Za-z0-9-]{8,100})$/;

export function isValidImageRef(v: string | null | undefined): boolean {
  if (v === null || v === undefined) return true;
  return ATTACHMENT_IMAGE_RE.test(v) || isSafeAssetUrl(v);
}

/** Upsert a product's storefront flags. The product must belong to the org and be active. */
export async function upsertStorefrontProduct(dataId: string, patch: StorefrontProductPatch): Promise<StorefrontProductDTO> {
  const p = await queryOne<{ id: string }>(`SELECT id FROM products WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`, [patch.product_id, dataId]);
  if (!p) throw new Error("Product not found");
  if (patch.image_url !== undefined && !isValidImageRef(patch.image_url)) throw new Error("image_url must be an http(s) URL or attachment:<id>");
  if (patch.image_url && ATTACHMENT_IMAGE_RE.test(patch.image_url)) {
    const attId = patch.image_url.slice("attachment:".length);
    const att = await queryOne<{ id: string }>(
      `SELECT id FROM attachments WHERE id = $1 AND user_id = $2 AND entity_kind = 'product' AND entity_id = $3 AND deleted_at IS NULL`,
      [attId, dataId, patch.product_id]
    ).catch(() => null);
    if (!att) throw new Error("Attachment not found on this product");
  }
  const existing = await queryOne<{ id: string }>(`SELECT id FROM storefront_products WHERE user_id = $1 AND product_id = $2`, [dataId, patch.product_id]);
  if (!existing) {
    await query(
      `INSERT INTO storefront_products (id, user_id, product_id, visible, sort, description_md, image_url) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [randomUUID(), dataId, patch.product_id, patch.visible ?? false, patch.sort ?? 0, patch.description_md ?? null, patch.image_url ?? null]
    );
  } else {
    const sets: string[] = ["updated_at = NOW()"];
    const params: unknown[] = [existing.id];
    const push = (col: string, v: unknown) => {
      params.push(v);
      sets.push(`${col} = $${params.length}`);
    };
    if (patch.visible !== undefined) push("visible", patch.visible);
    if (patch.sort !== undefined) push("sort", patch.sort);
    if (patch.description_md !== undefined) push("description_md", patch.description_md);
    if (patch.image_url !== undefined) push("image_url", patch.image_url);
    await query(`UPDATE storefront_products SET ${sets.join(", ")} WHERE id = $1`, params);
  }
  const row = await queryOne<JoinedRow>(`${SELECT} WHERE p.user_id = $1 AND p.id = $2`, [dataId, patch.product_id]);
  if (!row) throw new Error("Product not found");
  return toStorefrontProduct(row);
}

/** Public image URL for a catalog entry (attachment refs go through the public shop image route). */
export function publicImageUrl(slug: string, ref: string | null): string | null {
  if (!ref) return null;
  const m = ATTACHMENT_IMAGE_RE.exec(ref);
  if (m) return `/api/shop/${encodeURIComponent(slug)}/image/${m[1]}`;
  return isSafeAssetUrl(ref) ? ref : null;
}

export function toCatalogItem(p: StorefrontProductDTO, slug: string): CatalogItem {
  const avail = p.track_stock ? p.stock_available : null;
  return {
    id: p.id,
    sku: p.sku,
    name: p.name,
    description: p.description_md ?? p.description,
    unit: p.unit,
    price_minor: p.unit_price_minor,
    currency: p.currency,
    tax_rate_bp: p.tax_rate_bp,
    stock_available: avail,
    in_stock: avail === null || avail > 0,
    low_stock: p.low_stock,
    image_url: publicImageUrl(slug, p.image_url),
  };
}

/** Public: visible, active products in display order. */
export async function publicCatalog(dataId: string, slug: string): Promise<CatalogItem[]> {
  const rows = await query<JoinedRow>(
    `${SELECT} WHERE p.user_id = $1 AND p.deleted_at IS NULL AND p.active = TRUE AND sp.visible = TRUE ORDER BY sp.sort ASC, p.name ASC LIMIT 500`,
    [dataId]
  );
  return rows.map((r) => toCatalogItem(toStorefrontProduct(r), slug));
}

/** Public: the visible products referenced by a cart / order (keyed by product id). */
export async function visibleProductsByIds(dataId: string, ids: readonly string[]): Promise<Map<string, StorefrontProductDTO>> {
  const out = new Map<string, StorefrontProductDTO>();
  const uniq = [...new Set(ids.filter(Boolean))];
  if (uniq.length === 0) return out;
  const rows = await query<JoinedRow>(
    `${SELECT} WHERE p.user_id = $1 AND p.deleted_at IS NULL AND p.active = TRUE AND sp.visible = TRUE AND p.id = ANY($2::text[])`,
    [dataId, uniq]
  );
  for (const r of rows) out.set(r.id, toStorefrontProduct(r));
  return out;
}
