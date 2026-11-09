import { query } from "@/lib/dsql";
import { tableExistsVia } from "@/lib/db/catalog";

/**
 * Cheap, memoised "does this table exist" probe. Several Phase 3 lanes ship
 * tables independently (products, expenses, time_entries, tickets…), so
 * cross-lane code guards on presence instead of failing with a relation error.
 */
const cache = new Map<string, { ok: boolean; at: number }>();
const TTL_MS = 60_000;

export async function tableExists(name: string): Promise<boolean> {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) return false;
  const hit = cache.get(name);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.ok;
  const ok = await tableExistsVia((sql, params) => query(sql, params ?? []), name);
  cache.set(name, { ok, at: Date.now() });
  return ok;
}

/** Test hook. */
export function resetTableExistsCache(): void {
  cache.clear();
}
