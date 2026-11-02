/**
 * Opaque keyset cursors for /api/v1 lists (client-safe, no DB).
 *
 * Lists are ordered `created_at DESC, id DESC` (at millisecond precision, see
 * `keysetTs`); the cursor is base64url of `created_at|id` of the last row
 * returned. Offsets are never exposed.
 */

export interface Cursor {
  created_at: string;
  id: string;
}

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;

export function encodeCursor(c: Cursor): string {
  return Buffer.from(`${c.created_at}|${c.id}`, "utf8").toString("base64url");
}

/** Null for anything malformed (bad base64, missing parts, invalid date). */
export function decodeCursor(raw: string | null | undefined): Cursor | null {
  if (!raw) return null;
  if (raw.length > 512 || !/^[A-Za-z0-9_-]+$/.test(raw)) return null;
  let text: string;
  try {
    text = Buffer.from(raw, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const idx = text.indexOf("|");
  if (idx <= 0) return null;
  const created_at = text.slice(0, idx);
  const id = text.slice(idx + 1);
  if (!id || id.length > 200 || Number.isNaN(new Date(created_at).getTime())) return null;
  return { created_at, id };
}

export interface ListParams {
  limit: number;
  cursor: Cursor | null;
  q: string | null;
  /** True when a cursor was supplied but could not be decoded. */
  badCursor: boolean;
}

/** Parse `limit`, `cursor`, `q` from a request URL. Limit is clamped to [1, MAX_LIMIT]. */
export function parseListParams(url: URL | string, defaults: { limit?: number } = {}): ListParams {
  const sp = typeof url === "string" ? new URL(url).searchParams : url.searchParams;
  const rawLimit = Number(sp.get("limit") ?? "");
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), MAX_LIMIT) : defaults.limit ?? DEFAULT_LIMIT;
  const rawCursor = sp.get("cursor");
  const cursor = decodeCursor(rawCursor);
  const q = sp.get("q")?.trim().slice(0, 200) || null;
  return { limit, cursor, q, badCursor: Boolean(rawCursor) && !cursor };
}

/**
 * Timestamp expression used by both the keyset predicate and the ORDER BY.
 *
 * pg hands TIMESTAMPTZ back as a JS Date (millisecond precision) while the
 * column itself keeps microseconds (`DEFAULT NOW()`). A cursor therefore only
 * ever carries milliseconds, so the SQL side must compare — and order — at the
 * same precision, otherwise rows that share the last row's millisecond but
 * carry later microseconds are skipped on the next page.
 */
export function keysetTs(alias = "", col = "created_at"): string {
  return `date_trunc('milliseconds', ${alias}${col})`;
}

/**
 * Append a keyset predicate to a parameterised query. Pushes the two cursor
 * values onto `params` and returns the SQL fragment (empty when no cursor).
 * Always pair it with `keysetOrder()` so the ordering matches the predicate.
 *
 *   const params = [dataId];
 *   const where = `user_id = $1${keysetClause(cursor, params, { alias: "q." })}`;
 *   … ORDER BY ${keysetOrder("q.")} LIMIT ${limit + 1}
 */
export function keysetClause(cursor: Cursor | null | undefined, params: unknown[], opts: { alias?: string; col?: string; id?: string } = {}): string {
  if (!cursor) return "";
  const a = opts.alias ?? "";
  const col = opts.col ?? "created_at";
  const id = opts.id ?? "id";
  const ts = keysetTs(a, col);
  params.push(cursor.created_at, cursor.id);
  const n = params.length;
  return ` AND (${ts} < $${n - 1} OR (${ts} = $${n - 1} AND ${a}${id}::text < $${n}))`;
}

export function keysetOrder(alias = "", col = "created_at", id = "id"): string {
  return `${keysetTs(alias, col)} DESC, ${alias}${id} DESC`;
}

export interface Page<T> {
  data: T[];
  next_cursor: string | null;
}

/**
 * Given `limit + 1` rows, trim to `limit` and compute the next cursor from the
 * last returned row. `pick` extracts the (created_at, id) pair.
 */
export function page<T>(rows: T[], limit: number, pick: (row: T) => Cursor): Page<T> {
  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  const last = data[data.length - 1];
  return { data, next_cursor: hasMore && last ? encodeCursor(normaliseCursor(pick(last))) : null };
}

/** pg returns TIMESTAMPTZ as Date in some drivers and ISO strings in others; cursors always carry ISO. */
export function normaliseCursor(c: { created_at: string | Date; id: string | number }): Cursor {
  const created_at = c.created_at instanceof Date ? c.created_at.toISOString() : String(c.created_at);
  return { created_at, id: String(c.id) };
}
