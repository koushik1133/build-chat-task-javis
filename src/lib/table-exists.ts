import { query } from "@/lib/dsql";

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
  let ok = false;
  try {
    const rows = await query<{ n: string }>(
      `SELECT table_name AS n FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1 LIMIT 1`,
      [name]
    );
    ok = rows.length > 0;
  } catch {
    ok = false;
  }
  cache.set(name, { ok, at: Date.now() });
  return ok;
}

/** Test hook. */
export function resetTableExistsCache(): void {
  cache.clear();
}
