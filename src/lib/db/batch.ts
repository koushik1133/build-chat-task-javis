/**
 * Batching helpers for Aurora DSQL's per-transaction limits (at most 3,000 rows
 * modified and ~10 MiB of data per transaction). Every bulk write goes through
 * these helpers so no single statement/transaction touches more than
 * MAX_BATCH rows. Each statement runs in its own implicit transaction and is
 * retried on optimistic-concurrency conflicts.
 */
import { query, withRetry } from "@/lib/dsql";

/** Hard ceiling per statement/transaction (DSQL allows 3,000; stay well inside). */
export const MAX_BATCH = 1000;

const IDENT = /^[a-z_][a-z0-9_]*$/;

export function clampBatchSize(size: number | undefined, max = MAX_BATCH): number {
  const n = Number.isFinite(size) ? Math.floor(size as number) : max;
  return Math.max(1, Math.min(max, n));
}

/** Split `items` into arrays of at most `size` (default and max MAX_BATCH). */
export function chunk<T>(items: readonly T[], size = MAX_BATCH): T[][] {
  const n = clampBatchSize(size);
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += n) out.push(items.slice(i, i + n));
  return out;
}

/** Run `fn` sequentially over batches of at most `size` items; returns each batch's result. */
export async function inBatches<T, R = void>(
  items: readonly T[],
  size: number,
  fn: (batch: T[], index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = [];
  let i = 0;
  for (const batch of chunk(items, size)) results.push(await fn(batch, i++));
  return results;
}

type IdRunner = (sql: string, params: unknown[]) => Promise<Array<{ id: string }>>;
const defaultRun: IdRunner = (sql, params) => withRetry(() => query<{ id: string }>(sql, params));

export interface BatchOpts {
  /** Stop after this many batches (bounds a single cron tick). Default 50. */
  maxBatches?: number;
  /** Injectable runner (tests). */
  run?: IdRunner;
  /** Primary-key column used for the sub-select (default "id"). */
  idColumn?: string;
}

function assertIdent(name: string): void {
  if (!IDENT.test(name)) throw new Error(`invalid identifier: ${name}`);
}

/**
 * Core batched writer. `set === null` removes rows, otherwise updates them. `where` may use any
 * placeholders already numbered in `params`; the helper appends its own. Removal repeats a
 * `WHERE id IN (SELECT id ... LIMIT n)` statement until fewer than n rows go; updates page by
 * primary key (`id > last ORDER BY id`) so rows that still match after the update are not revisited.
 * Returns the total rows written. `table`/`set`/`where` must be trusted SQL fragments.
 */
export async function writeInBatches(
  table: string,
  set: string | null,
  where: string,
  params: unknown[],
  size = MAX_BATCH,
  opts: BatchOpts = {}
): Promise<number> {
  assertIdent(table);
  const n = clampBatchSize(size);
  const run = opts.run ?? defaultRun;
  const max = opts.maxBatches ?? 50;
  const idc = opts.idColumn ?? "id";
  assertIdent(idc);
  const k = params.length;
  let total = 0;
  if (set === null) {
    const sql = `DELETE FROM ${table} WHERE ${idc} IN (SELECT ${idc} FROM ${table} WHERE ${where} LIMIT $${k + 1}) RETURNING ${idc}::text AS id`;
    for (let b = 0; b < max; b++) {
      const rows = await run(sql, [...params, n]);
      total += rows.length;
      if (rows.length < n) break;
    }
    return total;
  }
  const sql = `UPDATE ${table} SET ${set} WHERE ${idc} IN (SELECT ${idc} FROM ${table} WHERE (${where}) AND ${idc}::text > $${k + 1} ORDER BY ${idc}::text LIMIT $${k + 2}) RETURNING ${idc}::text AS id`;
  let last = "";
  for (let b = 0; b < max; b++) {
    const rows = await run(sql, [...params, last, n]);
    total += rows.length;
    if (rows.length < n) break;
    last = rows.reduce((m, r) => (String(r.id) > m ? String(r.id) : m), last);
  }
  return total;
}

/** Remove rows matching `where` ($1..$n bound to `params`) in batches of `size`. Returns rows removed. */
export function deleteInBatches(table: string, where: string, params: unknown[], size = MAX_BATCH, opts: BatchOpts = {}): Promise<number> {
  return writeInBatches(table, null, where, params, size, opts);
}

/**
 * Update rows matching `where` in batches of `size`. params = [...whereParams, ...setParams]: `where`
 * uses $1..$k, `set` continues from $k+1.
 */
export function updateInBatches(
  table: string,
  set: string,
  where: string,
  whereParams: unknown[],
  setParams: unknown[] = [],
  size = MAX_BATCH,
  opts: BatchOpts = {}
): Promise<number> {
  return writeInBatches(table, set, where, [...whereParams, ...setParams], size, opts);
}

/**
 * Rewrite a simple `DELETE FROM t WHERE ...` / `UPDATE t SET ... WHERE ...` statement into batched
 * form. Returns null when the statement does not have that shape (caller runs it as-is).
 */
export async function runBatchedStatement(sql: string, params: unknown[], size = MAX_BATCH, opts: BatchOpts = {}): Promise<number | null> {
  const flat = sql.replace(/\s+/g, " ").trim().replace(/;$/, "");
  if (/\bRETURNING\b/i.test(flat)) return null;
  const rm = /^DELETE FROM ([a-z_][a-z0-9_]*) WHERE (.+)$/i.exec(flat);
  if (rm) return writeInBatches(rm[1].toLowerCase(), null, rm[2], params, size, opts);
  const upd = /^UPDATE ([a-z_][a-z0-9_]*) SET (.+?) WHERE (.+)$/i.exec(flat);
  if (upd) return writeInBatches(upd[1].toLowerCase(), upd[2], upd[3], params, size, opts);
  return null;
}

/**
 * Insert many rows with multi-row VALUES, `size` rows per statement. `cols` are trusted identifiers;
 * `rows` are value arrays aligned with `cols`.
 */
export async function insertInBatches(
  table: string,
  cols: readonly string[],
  rows: ReadonlyArray<readonly unknown[]>,
  size = 200,
  suffix = "",
  exec: (sql: string, params: unknown[]) => Promise<unknown> = (sql, params) => withRetry(() => query(sql, params))
): Promise<number> {
  assertIdent(table);
  cols.forEach(assertIdent);
  // Bind parameters are capped at 65,535 per statement.
  const n = Math.max(1, Math.min(clampBatchSize(size), Math.floor(60000 / Math.max(1, cols.length))));
  let total = 0;
  for (const batch of chunk(rows, n)) {
    const params: unknown[] = [];
    const tuples = batch.map((r) => {
      if (r.length !== cols.length) throw new Error("row/column count mismatch");
      return `(${r.map((v) => { params.push(v); return `$${params.length}`; }).join(", ")})`;
    });
    await exec(`INSERT INTO ${table} (${cols.join(", ")}) VALUES ${tuples.join(", ")} ${suffix}`.trim(), params);
    total += batch.length;
  }
  return total;
}
