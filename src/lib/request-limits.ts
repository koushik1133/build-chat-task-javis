/**
 * Guards for endpoints that anonymous callers can reach.
 *
 * Public lead capture feeds an LLM enrichment pass, so an unbounded body or an
 * unthrottled caller turns directly into third-party spend.
 */

/** Read a request body with a hard byte ceiling. Returns null if too large. */
export async function readCappedText(
  req: Request,
  maxBytes = 16_384
): Promise<string | null> {
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) return null;

  const text = await req.text();
  // content-length can be absent or wrong, so check the real size too.
  if (Buffer.byteLength(text, "utf8") > maxBytes) return null;
  return text;
}

/**
 * Flatten an arbitrary submitted form payload into a bounded record of strings,
 * so one caller cannot push megabytes of prompt into the enrichment step.
 */
export function sanitiseLeadPayload(
  value: unknown,
  opts: { maxFields?: number; maxValueLength?: number } = {}
): Record<string, string> | null {
  const maxFields = opts.maxFields ?? 40;
  const maxValueLength = opts.maxValueLength ?? 1_000;

  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  const out: Record<string, string> = {};
  let n = 0;
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (n >= maxFields) break;
    if (raw === null || raw === undefined) continue;

    const asString =
      typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean"
        ? String(raw)
        : JSON.stringify(raw);

    out[key.slice(0, 100)] = asString.slice(0, maxValueLength);
    n++;
  }
  return out;
}

/**
 * Fixed-window rate limiter.
 *
 * Two stores:
 *  - memory (default): per-process Map, hermetic for tests and fine for a
 *    single instance.
 *  - db (RATE_LIMIT_STORE=db): shared `rate_limits` table so the limit holds
 *    across instances. Conditional UPDATE first, INSERT fallback, both under
 *    withRetry. Any DB error fails OPEN (allowed) with a console.warn, because
 *    this is a cost guard, not a security control.
 *
 * `rateLimit()` keeps its synchronous signature and always uses memory.
 * `rateLimitAsync()` picks the store from the env; API routes use it.
 */
const buckets = new Map<string, { count: number; resetAt: number }>();

export interface RateLimitOptions {
  limit: number;
  windowMs: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  /** Epoch ms at which the current window ends. */
  resetAt: number;
}

function normalise(limitOrOpts: number | RateLimitOptions, windowMsArg?: number): RateLimitOptions {
  return typeof limitOrOpts === "number"
    ? { limit: limitOrOpts, windowMs: windowMsArg ?? 60_000 }
    : limitOrOpts;
}

export type RateLimitStore = "memory" | "db";

export function rateLimitStore(env: Record<string, string | undefined> = process.env): RateLimitStore {
  return env.RATE_LIMIT_STORE === "db" ? "db" : "memory";
}

export function rateLimit(key: string, limit: number, windowMs: number): RateLimitResult;
export function rateLimit(key: string, opts: RateLimitOptions): RateLimitResult;
export function rateLimit(
  key: string,
  limitOrOpts: number | RateLimitOptions,
  windowMsArg?: number
): RateLimitResult {
  const { limit, windowMs } = normalise(limitOrOpts, windowMsArg);
  const now = Date.now();
  const bucket = buckets.get(key);

  if (!bucket || now >= bucket.resetAt) {
    const resetAt = now + windowMs;
    buckets.set(key, { count: 1, resetAt });
    // Opportunistically drop expired buckets so the map cannot grow forever.
    if (buckets.size > 5_000) {
      for (const [k, v] of buckets) if (now >= v.resetAt) buckets.delete(k);
    }
    return { allowed: true, remaining: limit - 1, resetAt };
  }

  if (bucket.count >= limit) return { allowed: false, remaining: 0, resetAt: bucket.resetAt };
  bucket.count++;
  return { allowed: true, remaining: limit - bucket.count, resetAt: bucket.resetAt };
}

interface DbRow { count: number | string; window_start: string }

/**
 * Postgres-backed fixed window. The window is anchored at `window_start`; a
 * row whose window has elapsed is reset in place. Exported for tests.
 */
export async function rateLimitDb(key: string, opts: RateLimitOptions): Promise<RateLimitResult> {
  const { query, queryOne, withRetry } = await import("@/lib/dsql");
  const now = Date.now();
  const cutoff = new Date(now - opts.windowMs).toISOString();
  const nowIso = new Date(now).toISOString();
  return withRetry(async () => {
    // 1) Window elapsed → reset to count 1.
    let rows = await query<DbRow>(
      `UPDATE rate_limits SET count = 1, window_start = $2, updated_at = $2
        WHERE key = $1 AND window_start <= $3 RETURNING count, window_start`,
      [key, nowIso, cutoff]
    );
    // 2) Live window → increment (conditional on being under the limit so the
    //    counter never overshoots; a no-op means the limit is hit).
    if (rows.length === 0) {
      rows = await query<DbRow>(
        `UPDATE rate_limits SET count = count + 1, updated_at = $2
          WHERE key = $1 AND window_start > $3 AND count < $4 RETURNING count, window_start`,
        [key, nowIso, cutoff, opts.limit]
      );
    }
    // 3) No row at all → insert.
    if (rows.length === 0) {
      const existing = await queryOne<DbRow>(`SELECT count, window_start FROM rate_limits WHERE key = $1`, [key]);
      if (!existing) {
        rows = await query<DbRow>(
          `INSERT INTO rate_limits (key, count, window_start, updated_at) VALUES ($1, 1, $2, $2) RETURNING count, window_start`,
          [key, nowIso]
        );
      } else {
        // Row exists, window live, count at limit.
        return { allowed: false, remaining: 0, resetAt: new Date(existing.window_start).getTime() + opts.windowMs };
      }
    }
    const row = rows[0];
    const count = Number(row.count);
    return { allowed: count <= opts.limit, remaining: Math.max(opts.limit - count, 0), resetAt: new Date(row.window_start).getTime() + opts.windowMs };
  });
}

/** Store-aware limiter for route handlers. Fails open on DB errors. */
export async function rateLimitAsync(key: string, limit: number, windowMs: number): Promise<RateLimitResult>;
export async function rateLimitAsync(key: string, opts: RateLimitOptions): Promise<RateLimitResult>;
export async function rateLimitAsync(
  key: string,
  limitOrOpts: number | RateLimitOptions,
  windowMsArg?: number
): Promise<RateLimitResult> {
  const opts = normalise(limitOrOpts, windowMsArg);
  if (rateLimitStore() !== "db") return rateLimit(key, opts);
  try {
    return await rateLimitDb(key, opts);
  } catch (err) {
    console.warn("[rate-limit] db store failed; allowing request", err instanceof Error ? err.message : err);
    return { allowed: true, remaining: opts.limit, resetAt: Date.now() + opts.windowMs };
  }
}

/**
 * Delete rate_limits rows idle for longer than `olderThanMs` (default 24h).
 * Cron hook: call once per tick (any store; no-op when the table is absent).
 */
export async function pruneRateLimits(olderThanMs = 24 * 60 * 60 * 1000): Promise<number> {
  try {
    const { query } = await import("@/lib/dsql");
    const rows = await query<{ key: string }>(
      `DELETE FROM rate_limits WHERE updated_at < $1 RETURNING key`,
      [new Date(Date.now() - olderThanMs).toISOString()]
    );
    return rows.length;
  } catch (err) {
    console.warn("[rate-limit] prune failed", err instanceof Error ? err.message : err);
    return 0;
  }
}

/** Test hook: clear every bucket. */
export function resetRateLimits(): void {
  buckets.clear();
}

/**
 * Apply several limits at once (e.g. 5/hour AND 20/day). Every bucket is
 * consumed so a burst counts against each window.
 */
export function rateLimitAll(
  keyPrefix: string,
  limits: Array<RateLimitOptions & { name: string }>
): RateLimitResult {
  let worst: RateLimitResult = { allowed: true, remaining: Number.MAX_SAFE_INTEGER, resetAt: 0 };
  for (const l of limits) {
    const r = rateLimit(`${keyPrefix}:${l.name}`, l);
    if (!r.allowed) return r;
    if (r.remaining < worst.remaining) worst = r;
  }
  return worst;
}

/** Async, store-aware variant of rateLimitAll. */
export async function rateLimitAllAsync(
  keyPrefix: string,
  limits: Array<RateLimitOptions & { name: string }>
): Promise<RateLimitResult> {
  let worst: RateLimitResult = { allowed: true, remaining: Number.MAX_SAFE_INTEGER, resetAt: 0 };
  for (const l of limits) {
    const r = await rateLimitAsync(`${keyPrefix}:${l.name}`, l);
    if (!r.allowed) return r;
    if (r.remaining < worst.remaining) worst = r;
  }
  return worst;
}

/** Best-effort caller IP for rate-limit keys (trusts the first forwarded hop). */
export function clientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim() || "unknown";
  return req.headers.get("x-real-ip")?.trim() || "unknown";
}

/** Standard auth-endpoint limits: 5/hour and 20/day per IP. */
export function authRateLimit(name: string, req: Request): RateLimitResult {
  const ip = clientIp(req);
  return rateLimitAll(`auth:${name}:${ip}`, [
    { name: "hour", limit: 5, windowMs: 60 * 60 * 1000 },
    { name: "day", limit: 20, windowMs: 24 * 60 * 60 * 1000 },
  ]);
}

/** Async, store-aware variant of authRateLimit (used by the auth routes). */
export async function authRateLimitAsync(name: string, req: Request): Promise<RateLimitResult> {
  const ip = clientIp(req);
  return rateLimitAllAsync(`auth:${name}:${ip}`, [
    { name: "hour", limit: 5, windowMs: 60 * 60 * 1000 },
    { name: "day", limit: 20, windowMs: 24 * 60 * 60 * 1000 },
  ]);
}
