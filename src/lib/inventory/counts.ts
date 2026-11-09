import { randomUUID } from "crypto";
import { z } from "zod";
import { query, queryOne } from "@/lib/dsql";
import { chunk } from "@/lib/db/batch";
import { ensureLevelsBackfilled, getLocation } from "./locations";
import { adjustStock } from "./stock";
import { countVariance, summariseCount, type CountSummary } from "./locations-pure";

/**
 * Cycle counts for one location. Opening a count snapshots the expected
 * quantities; entering counts records what was found; applying creates one
 * `adjust` movement per variance (idempotent per count + product).
 */

export const CountLinesSchema = z
  .object({ lines: z.array(z.object({ product_id: z.string().min(1).max(100), counted_qty: z.number().int().min(0).max(100_000_000).nullable() }).strict()).min(1).max(1000) })
  .strict();
export type CountLinesInput = z.infer<typeof CountLinesSchema>;

export class CountError extends Error {
  constructor(public readonly code: "not_found" | "bad_state" | "invalid", message: string) {
    super(message);
    this.name = "CountError";
  }
}
export function isCountError(e: unknown): e is CountError {
  return e instanceof CountError || (e instanceof Error && e.name === "CountError");
}

interface CountRow {
  id: string;
  user_id: string;
  location_id: string;
  status: "open" | "counted" | "applied";
  created_by: string | null;
  created_at: string;
  applied_at: string | null;
  location_name?: string | null;
}
export interface CountLineDTO {
  id: string;
  product_id: string;
  product_name: string | null;
  product_sku: string | null;
  expected_qty: number;
  counted_qty: number | null;
  variance: number | null;
}
export interface CountDTO extends Omit<CountRow, "user_id" | "location_name"> {
  location_name: string | null;
  lines: CountLineDTO[];
  summary: CountSummary;
}

async function loadLines(dataId: string, countId: string): Promise<CountLineDTO[]> {
  const rows = await query<{ id: string; product_id: string; expected_qty: number | string; counted_qty: number | string | null; product_name: string | null; product_sku: string | null }>(
    `SELECT l.id, l.product_id, l.expected_qty, l.counted_qty, p.name AS product_name, p.sku AS product_sku
       FROM stock_count_lines l LEFT JOIN products p ON p.id = l.product_id WHERE l.user_id = $1 AND l.count_id = $2 ORDER BY p.name ASC`,
    [dataId, countId]
  );
  return rows.map((r) => {
    const expected = Number(r.expected_qty);
    const counted = r.counted_qty === null ? null : Number(r.counted_qty);
    return { id: r.id, product_id: r.product_id, product_name: r.product_name, product_sku: r.product_sku, expected_qty: expected, counted_qty: counted, variance: countVariance(expected, counted) };
  });
}

export async function getCount(dataId: string, id: string): Promise<CountDTO | null> {
  const r = await queryOne<CountRow>(
    `SELECT c.*, l.name AS location_name FROM stock_counts c LEFT JOIN locations l ON l.id = c.location_id WHERE c.id = $1 AND c.user_id = $2`,
    [id, dataId]
  );
  if (!r) return null;
  const lines = await loadLines(dataId, id);
  const { user_id: _u, location_name, ...rest } = r;
  void _u;
  return { ...rest, location_name: location_name ?? null, lines, summary: summariseCount(lines) };
}

export async function listCounts(dataId: string, limit = 100): Promise<Array<Omit<CountDTO, "lines">>> {
  const rows = await query<CountRow & { line_count: number | string; counted_count: number | string }>(
    `SELECT c.*, l.name AS location_name,
            (SELECT COUNT(*) FROM stock_count_lines x WHERE x.user_id = c.user_id AND x.count_id = c.id) AS line_count,
            (SELECT COUNT(*) FROM stock_count_lines x WHERE x.user_id = c.user_id AND x.count_id = c.id AND x.counted_qty IS NOT NULL) AS counted_count
       FROM stock_counts c LEFT JOIN locations l ON l.id = c.location_id WHERE c.user_id = $1 ORDER BY c.created_at DESC LIMIT $2`,
    [dataId, Math.min(Math.max(limit, 1), 500)]
  );
  return rows.map((r) => {
    const { user_id: _u, location_name, line_count, counted_count, ...rest } = r;
    void _u;
    return { ...rest, location_name: location_name ?? null, summary: { lines: Number(line_count), counted: Number(counted_count), with_variance: 0, net_variance: 0, shrinkage: 0, overage: 0 } };
  });
}

export async function openCount(dataId: string, locationId: string, actorId?: string | null): Promise<CountDTO> {
  const loc = await getLocation(dataId, locationId);
  if (!loc) throw new CountError("not_found", "Location not found");
  if (!loc.active) throw new CountError("invalid", "Location is archived");
  await ensureLevelsBackfilled(dataId);
  const id = randomUUID();
  await query(`INSERT INTO stock_counts (id, user_id, location_id, status, created_by) VALUES ($1, $2, $3, 'open', $4)`, [id, dataId, locationId, actorId ?? null]);
  const levels = await query<{ product_id: string; on_hand: number | string }>(
    `SELECT s.product_id, s.on_hand FROM stock_levels s JOIN products p ON p.id = s.product_id
      WHERE s.user_id = $1 AND s.location_id = $2 AND p.deleted_at IS NULL AND p.track_stock = TRUE ORDER BY s.product_id`,
    [dataId, locationId]
  );
  for (const batch of chunk(levels, 500)) {
    const params: unknown[] = [];
    const values = batch.map((l, i) => {
      params.push(randomUUID(), dataId, id, l.product_id, Number(l.on_hand));
      const b = i * 5;
      return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, NULL)`;
    });
    await query(`INSERT INTO stock_count_lines (id, user_id, count_id, product_id, expected_qty, counted_qty) VALUES ${values.join(", ")}`, params);
  }
  const out = await getCount(dataId, id);
  if (!out) throw new Error("Count vanished after insert");
  return out;
}

export async function saveCountLines(dataId: string, id: string, input: CountLinesInput): Promise<CountDTO> {
  const c = await getCount(dataId, id);
  if (!c) throw new CountError("not_found", "Count not found");
  if (c.status === "applied") throw new CountError("bad_state", "This count has already been applied");
  const known = new Set(c.lines.map((l) => l.product_id));
  for (const l of input.lines) if (!known.has(l.product_id)) throw new CountError("invalid", `Product ${l.product_id} is not part of this count`);
  for (const l of input.lines) {
    await query(`UPDATE stock_count_lines SET counted_qty = $4 WHERE user_id = $1 AND count_id = $2 AND product_id = $3`, [dataId, id, l.product_id, l.counted_qty]);
  }
  await query(`UPDATE stock_counts SET status = 'counted' WHERE id = $1 AND user_id = $2 AND status IN ('open', 'counted')`, [id, dataId]);
  const out = await getCount(dataId, id);
  if (!out) throw new CountError("not_found", "Count not found");
  return out;
}

/** Apply variances (counted − expected) as `adjust` movements at the count's location. Idempotent. */
export async function applyCount(dataId: string, id: string, actorId?: string | null): Promise<CountDTO> {
  const c = await getCount(dataId, id);
  if (!c) throw new CountError("not_found", "Count not found");
  if (c.status === "applied") return c;
  if (c.status !== "counted") throw new CountError("bad_state", "Enter counted quantities before applying");
  for (const l of c.lines) {
    if (l.variance === null || l.variance === 0) continue;
    const done = await queryOne<{ id: string }>(
      `SELECT id FROM stock_movements WHERE user_id = $1 AND ref_kind = 'stock_count' AND ref_id = $2 AND product_id = $3 LIMIT 1`,
      [dataId, id, l.product_id]
    );
    if (done) continue;
    await adjustStock(dataId, l.product_id, { kind: "adjust", qty: l.variance, ref_kind: "stock_count", ref_id: id, location_id: c.location_id, note: `Count variance (expected ${l.expected_qty}, counted ${l.counted_qty})` }, actorId ?? null);
  }
  await query(`UPDATE stock_counts SET status = 'applied', applied_at = NOW() WHERE id = $1 AND user_id = $2 AND status = 'counted'`, [id, dataId]);
  const out = await getCount(dataId, id);
  if (!out) throw new CountError("not_found", "Count not found");
  return out;
}
