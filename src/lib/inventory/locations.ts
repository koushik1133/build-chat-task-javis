import { randomUUID } from "crypto";
import { z } from "zod";
import { query, queryOne, withRetry } from "@/lib/dsql";
import { tableExists } from "@/lib/table-exists";
import { LOCATION_KINDS } from "./locations-pure";

/**
 * Stock locations. `products.stock_on_hand` / `stock_reserved` stay the
 * org-wide totals; `stock_levels` holds the per-location breakdown. An org
 * that never created a location keeps the legacy single-stock behaviour.
 */

export const AddressSchema = z
  .object({
    line1: z.string().trim().max(200).nullable().optional(),
    line2: z.string().trim().max(200).nullable().optional(),
    city: z.string().trim().max(100).nullable().optional(),
    region: z.string().trim().max(100).nullable().optional(),
    postal_code: z.string().trim().max(20).nullable().optional(),
    country: z.string().trim().max(2).nullable().optional(),
  })
  .strict();

export const LocationInputSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    code: z.string().trim().max(20).nullable().optional(),
    kind: z.enum(LOCATION_KINDS).optional(),
    address: AddressSchema.nullable().optional(),
    is_default: z.boolean().optional(),
  })
  .strict();
export type LocationInput = z.infer<typeof LocationInputSchema>;

export const LocationPatchSchema = LocationInputSchema.partial().extend({ active: z.boolean().optional() }).strict();
export type LocationPatch = z.infer<typeof LocationPatchSchema>;

export interface LocationRow {
  id: string;
  user_id: string;
  name: string;
  code: string | null;
  kind: string;
  address: string | null;
  active: boolean;
  is_default: boolean;
  created_at: string;
  updated_at: string;
}
export interface LocationDTO extends Omit<LocationRow, "address" | "user_id"> {
  address: Record<string, unknown> | null;
}

export class LocationError extends Error {
  constructor(public readonly code: "not_found" | "has_stock" | "is_default" | "inactive", message: string) {
    super(message);
    this.name = "LocationError";
  }
}

function toDTO(r: LocationRow): LocationDTO {
  let address: Record<string, unknown> | null = null;
  if (r.address) {
    try {
      const v: unknown = JSON.parse(r.address);
      address = v && typeof v === "object" ? (v as Record<string, unknown>) : null;
    } catch {
      address = null;
    }
  }
  const { user_id: _u, ...rest } = r;
  void _u;
  return { ...rest, address };
}

export async function locationsAvailable(): Promise<boolean> {
  return (await tableExists("locations")) && (await tableExists("stock_levels"));
}

export async function listLocations(dataId: string, opts: { includeInactive?: boolean } = {}): Promise<LocationDTO[]> {
  if (!(await locationsAvailable())) return [];
  const rows = await query<LocationRow>(
    `SELECT * FROM locations WHERE user_id = $1 ${opts.includeInactive ? "" : "AND active = TRUE"} ORDER BY is_default DESC, name ASC LIMIT 500`,
    [dataId]
  );
  return rows.map(toDTO);
}

export async function getLocation(dataId: string, id: string): Promise<LocationDTO | null> {
  if (!(await locationsAvailable())) return null;
  const r = await queryOne<LocationRow>(`SELECT * FROM locations WHERE id = $1 AND user_id = $2`, [id, dataId]);
  return r ? toDTO(r) : null;
}

/** The default location id if the org has one, WITHOUT creating it (null = legacy single-stock mode). */
export async function findDefaultLocationId(dataId: string): Promise<string | null> {
  if (!(await locationsAvailable())) return null;
  const r = await queryOne<{ id: string }>(`SELECT id FROM locations WHERE user_id = $1 AND is_default = TRUE AND active = TRUE ORDER BY created_at ASC LIMIT 1`, [dataId]);
  if (r) return r.id;
  const any = await queryOne<{ id: string }>(`SELECT id FROM locations WHERE user_id = $1 AND active = TRUE ORDER BY created_at ASC LIMIT 1`, [dataId]);
  return any?.id ?? null;
}

/** Default location, lazily created as "Main" (and levels backfilled) the first time it is needed. */
export async function getDefaultLocationId(dataId: string): Promise<string> {
  const found = await findDefaultLocationId(dataId);
  if (found) return found;
  if (!(await locationsAvailable())) throw new Error("Locations are not available yet");
  const id = randomUUID();
  await query(`INSERT INTO locations (id, user_id, name, code, kind, is_default) VALUES ($1, $2, 'Main', 'MAIN', 'warehouse', TRUE)`, [id, dataId]);
  // Concurrent creators: keep the oldest default.
  const winner = await findDefaultLocationId(dataId);
  const chosen = winner ?? id;
  if (chosen !== id) await query(`DELETE FROM locations WHERE id = $1 AND user_id = $2`, [id, dataId]);
  await ensureLevelsBackfilled(dataId);
  return chosen;
}

const BACKFILL_BATCH = 1000;

/**
 * Idempotent: give every tracked product a stock_levels row at the default
 * location seeded from products.stock_on_hand / stock_reserved. Batched; safe
 * to call on every request that touches levels (a cheap no-op once done).
 */
export async function ensureLevelsBackfilled(dataId: string): Promise<{ created: number }> {
  const loc = await findDefaultLocationId(dataId);
  if (!loc) return { created: 0 };
  let created = 0;
  for (let i = 0; i < 100; i++) {
    const rows = await withRetry(() =>
      query<{ product_id: string }>(
        `INSERT INTO stock_levels (user_id, product_id, location_id, on_hand, reserved)
         SELECT p.user_id, p.id, $2, p.stock_on_hand, p.stock_reserved FROM products p
          WHERE p.user_id = $1 AND p.deleted_at IS NULL AND p.track_stock = TRUE
            AND NOT EXISTS (SELECT 1 FROM stock_levels s WHERE s.user_id = $1 AND s.product_id = p.id)
          ORDER BY p.id LIMIT ${BACKFILL_BATCH}
         ON CONFLICT (user_id, product_id, location_id) DO NOTHING
         RETURNING product_id`,
        [dataId, loc]
      )
    );
    created += rows.length;
    if (rows.length < BACKFILL_BATCH) break;
  }
  return { created };
}

export async function createLocation(dataId: string, input: LocationInput): Promise<LocationDTO> {
  if (!(await locationsAvailable())) throw new Error("Locations are not available yet");
  const existing = await queryOne<{ c: string | number }>(`SELECT COUNT(*) AS c FROM locations WHERE user_id = $1 AND active = TRUE`, [dataId]);
  const first = Number(existing?.c ?? 0) === 0;
  const isDefault = first || input.is_default === true;
  const id = randomUUID();
  await query(
    `INSERT INTO locations (id, user_id, name, code, kind, address, is_default) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, dataId, input.name, input.code ?? null, input.kind ?? "warehouse", input.address ? JSON.stringify(input.address) : null, isDefault]
  );
  if (isDefault) await query(`UPDATE locations SET is_default = FALSE, updated_at = NOW() WHERE user_id = $1 AND id <> $2 AND is_default = TRUE`, [dataId, id]);
  if (first) await ensureLevelsBackfilled(dataId);
  const out = await getLocation(dataId, id);
  if (!out) throw new Error("Location vanished after insert");
  return out;
}

async function stockAt(dataId: string, locationId: string): Promise<{ on_hand: number; reserved: number }> {
  const r = await queryOne<{ o: string | number | null; r: string | number | null }>(
    `SELECT COALESCE(SUM(on_hand), 0) AS o, COALESCE(SUM(reserved), 0) AS r FROM stock_levels WHERE user_id = $1 AND location_id = $2`,
    [dataId, locationId]
  );
  return { on_hand: Number(r?.o ?? 0), reserved: Number(r?.r ?? 0) };
}

export async function updateLocation(dataId: string, id: string, patch: LocationPatch): Promise<LocationDTO> {
  const cur = await getLocation(dataId, id);
  if (!cur) throw new LocationError("not_found", "Location not found");
  if (patch.active === false && cur.active) {
    if (cur.is_default) throw new LocationError("is_default", "Make another location the default before archiving this one");
    const s = await stockAt(dataId, id);
    if (s.on_hand > 0 || s.reserved > 0) throw new LocationError("has_stock", `Cannot archive: ${s.on_hand} unit(s) are still stored here. Transfer or adjust them first`);
    if (await tableExists("stock_transfers")) {
      const open = await queryOne<{ id: string }>(
        `SELECT id FROM stock_transfers WHERE user_id = $1 AND status IN ('draft', 'in_transit') AND (from_location_id = $2 OR to_location_id = $2) LIMIT 1`,
        [dataId, id]
      );
      if (open) throw new LocationError("has_stock", "Cannot archive: open transfers use this location");
    }
  }
  const name = patch.name ?? cur.name;
  const code = patch.code === undefined ? cur.code : patch.code;
  const kind = patch.kind ?? cur.kind;
  const address = patch.address === undefined ? cur.address : patch.address;
  const active = patch.active ?? cur.active;
  const makeDefault = patch.is_default === true && active;
  await query(
    `UPDATE locations SET name = $3, code = $4, kind = $5, address = $6, active = $7, is_default = CASE WHEN $8 THEN TRUE WHEN $7 = FALSE THEN FALSE ELSE is_default END, updated_at = NOW()
      WHERE id = $1 AND user_id = $2`,
    [id, dataId, name, code, kind, address ? JSON.stringify(address) : null, active, makeDefault]
  );
  if (makeDefault) await query(`UPDATE locations SET is_default = FALSE, updated_at = NOW() WHERE user_id = $1 AND id <> $2 AND is_default = TRUE`, [dataId, id]);
  const out = await getLocation(dataId, id);
  if (!out) throw new LocationError("not_found", "Location not found");
  return out;
}

export function isLocationError(e: unknown): e is LocationError {
  return e instanceof LocationError || (e instanceof Error && e.name === "LocationError");
}
