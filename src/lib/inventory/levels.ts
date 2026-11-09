import { query, queryOne } from "@/lib/dsql";
import { chunk } from "@/lib/db/batch";
import { ensureLevelsBackfilled, findDefaultLocationId, locationsAvailable } from "./locations";
import type { LocationAvailability } from "./locations-pure";

/** Per-location stock levels (read side + the lazy seeding the stock ledger relies on). */

export interface StockLevelDTO {
  product_id: string;
  product_name: string;
  product_sku: string | null;
  location_id: string;
  location_name: string;
  on_hand: number;
  reserved: number;
  available: number;
  reorder_point: number | null;
  low: boolean;
}

interface LevelRow {
  product_id: string;
  product_name: string;
  product_sku: string | null;
  location_id: string;
  location_name: string;
  on_hand: number | string;
  reserved: number | string;
  reorder_point: number | string | null;
}

export async function listLevels(dataId: string, opts: { productId?: string | null; locationId?: string | null; limit?: number } = {}): Promise<StockLevelDTO[]> {
  if (!(await locationsAvailable())) return [];
  await ensureLevelsBackfilled(dataId);
  const params: unknown[] = [dataId];
  let sql = `SELECT s.product_id, p.name AS product_name, p.sku AS product_sku, s.location_id, l.name AS location_name, s.on_hand, s.reserved, s.reorder_point
               FROM stock_levels s JOIN products p ON p.id = s.product_id JOIN locations l ON l.id = s.location_id
              WHERE s.user_id = $1 AND p.deleted_at IS NULL`;
  if (opts.productId) {
    params.push(opts.productId);
    sql += ` AND s.product_id = $${params.length}`;
  }
  if (opts.locationId) {
    params.push(opts.locationId);
    sql += ` AND s.location_id = $${params.length}`;
  }
  params.push(Math.min(Math.max(opts.limit ?? 500, 1), 2000));
  sql += ` ORDER BY p.name ASC, l.name ASC LIMIT $${params.length}`;
  const rows = await query<LevelRow>(sql, params);
  return rows.map((r) => {
    const on = Number(r.on_hand);
    const res = Number(r.reserved);
    const rp = r.reorder_point === null ? null : Number(r.reorder_point);
    return { product_id: r.product_id, product_name: r.product_name, product_sku: r.product_sku, location_id: r.location_id, location_name: r.location_name, on_hand: on, reserved: res, available: on - res, reorder_point: rp, low: rp !== null && on - res <= rp };
  });
}

/**
 * Make sure a product has a levels breakdown: when it has none yet, its
 * current totals are seeded at the default location. Idempotent and race-safe
 * (primary-key conflicts are ignored).
 */
export async function seedProductLevels(dataId: string, productId: string): Promise<void> {
  const def = await findDefaultLocationId(dataId);
  if (!def) return;
  await query(
    `INSERT INTO stock_levels (user_id, product_id, location_id, on_hand, reserved)
     SELECT p.user_id, p.id, $3, p.stock_on_hand, p.stock_reserved FROM products p
      WHERE p.id = $2 AND p.user_id = $1 AND NOT EXISTS (SELECT 1 FROM stock_levels s WHERE s.user_id = $1 AND s.product_id = $2)
     ON CONFLICT (user_id, product_id, location_id) DO NOTHING`,
    [dataId, productId, def]
  );
}

/** Available (on_hand − reserved) of one product at one location; 0 when there is no level row. */
export async function availableAt(dataId: string, productId: string, locationId: string): Promise<number> {
  if (!(await locationsAvailable())) return 0;
  await seedProductLevels(dataId, productId);
  const r = await queryOne<{ on_hand: number | string; reserved: number | string }>(
    `SELECT on_hand, reserved FROM stock_levels WHERE user_id = $1 AND product_id = $2 AND location_id = $3`,
    [dataId, productId, locationId]
  );
  return r ? Number(r.on_hand) - Number(r.reserved) : 0;
}

/** Ensure the (product, location) row exists (zeroed) after seeding the product's default row. */
export async function ensureLevelRow(dataId: string, productId: string, locationId: string): Promise<void> {
  await seedProductLevels(dataId, productId);
  await query(
    `INSERT INTO stock_levels (user_id, product_id, location_id, on_hand, reserved) VALUES ($1, $2, $3, 0, 0)
     ON CONFLICT (user_id, product_id, location_id) DO NOTHING`,
    [dataId, productId, locationId]
  );
}

/** Availability per active location for a set of products (for allocation). */
export async function availabilityFor(dataId: string, productIds: readonly string[]): Promise<Map<string, LocationAvailability[]>> {
  const out = new Map<string, LocationAvailability[]>();
  const unique = [...new Set(productIds)];
  for (const id of unique) await seedProductLevels(dataId, id);
  for (const ids of chunk(unique, 500)) {
    if (ids.length === 0) continue;
    const rows = await query<{ product_id: string; location_id: string; on_hand: number | string; reserved: number | string }>(
      `SELECT s.product_id, s.location_id, s.on_hand, s.reserved FROM stock_levels s JOIN locations l ON l.id = s.location_id AND l.active = TRUE
        WHERE s.user_id = $1 AND s.product_id = ANY($2)`,
      [dataId, ids]
    );
    for (const r of rows) {
      const list = out.get(r.product_id) ?? [];
      list.push({ location_id: r.location_id, available: Number(r.on_hand) - Number(r.reserved) });
      out.set(r.product_id, list);
    }
  }
  return out;
}

export interface InvariantMismatch {
  product_id: string;
  total_on_hand: number;
  levels_on_hand: number;
  in_transit: number;
  total_reserved: number;
  levels_reserved: number;
}

/**
 * Check sum(stock_levels) == products totals. Units shipped on an open transfer
 * but not yet received are still org stock, so they count alongside the levels.
 * Only products that have levels rows are compared.
 */
export async function checkStockInvariant(dataId: string): Promise<InvariantMismatch[]> {
  if (!(await locationsAvailable())) return [];
  const rows = await query<{ id: string; stock_on_hand: number | string; stock_reserved: number | string; lo: number | string; lr: number | string; it: number | string }>(
    `SELECT p.id, p.stock_on_hand, p.stock_reserved,
            (SELECT COALESCE(SUM(s.on_hand), 0) FROM stock_levels s WHERE s.user_id = p.user_id AND s.product_id = p.id) AS lo,
            (SELECT COALESCE(SUM(s.reserved), 0) FROM stock_levels s WHERE s.user_id = p.user_id AND s.product_id = p.id) AS lr,
            (SELECT COALESCE(SUM(tl.qty - tl.received_qty), 0) FROM stock_transfer_lines tl JOIN stock_transfers t ON t.id = tl.transfer_id
              WHERE tl.user_id = p.user_id AND tl.product_id = p.id AND t.status = 'in_transit') AS it
       FROM products p
      WHERE p.user_id = $1 AND p.deleted_at IS NULL AND EXISTS (SELECT 1 FROM stock_levels s WHERE s.user_id = p.user_id AND s.product_id = p.id)`,
    [dataId]
  );
  return rows
    .map((r) => ({ product_id: r.id, total_on_hand: Number(r.stock_on_hand), levels_on_hand: Number(r.lo), in_transit: Number(r.it), total_reserved: Number(r.stock_reserved), levels_reserved: Number(r.lr) }))
    .filter((m) => m.total_on_hand !== m.levels_on_hand + m.in_transit || m.total_reserved !== m.levels_reserved);
}
