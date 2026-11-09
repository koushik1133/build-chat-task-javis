import { query, queryOne, withRetry } from "@/lib/dsql";

/**
 * Tiny key/value store (`system_state`) for operational facts the health page
 * shows: cron last tick, counts. Values are JSON TEXT.
 */

export async function setSystemState(key: string, value: unknown): Promise<void> {
  const json = JSON.stringify(value ?? null);
  await withRetry(async () => {
    const rows = await query<{ key: string }>(`UPDATE system_state SET value = $2, updated_at = NOW() WHERE key = $1 RETURNING key`, [key, json]);
    if (rows.length === 0) await query(`INSERT INTO system_state (key, value, updated_at) VALUES ($1, $2, NOW())`, [key, json]);
  });
}

export async function getSystemState<T = unknown>(key: string): Promise<{ value: T; updatedAt: string } | null> {
  const row = await queryOne<{ value: string | null; updated_at: string }>(`SELECT value, updated_at FROM system_state WHERE key = $1`, [key]);
  if (!row) return null;
  let value: T;
  try {
    value = JSON.parse(row.value ?? "null") as T;
  } catch {
    value = null as T;
  }
  return { value, updatedAt: row.updated_at };
}

export const CRON_TICK_KEY = "cron:agents:last_tick";

/**
 * Cron hook — call at the end of each agents tick:
 *   await recordCronTick(counts).catch(() => undefined);
 */
export async function recordCronTick(counts: Record<string, number>): Promise<void> {
  await setSystemState(CRON_TICK_KEY, { at: new Date().toISOString(), counts });
}
