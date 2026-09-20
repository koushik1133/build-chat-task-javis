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
 * Fixed-window rate limiter kept in process memory.
 *
 * This bounds a single instance only — it is a cost guard, not a security
 * control. A durable limiter belongs in the datastore if this ever needs to
 * hold across instances.
 */
const buckets = new Map<string, { count: number; resetAt: number }>();

export function rateLimit(
  key: string,
  limit: number,
  windowMs: number
): { allowed: boolean; remaining: number } {
  const now = Date.now();
  const bucket = buckets.get(key);

  if (!bucket || now >= bucket.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    // Opportunistically drop expired buckets so the map cannot grow forever.
    if (buckets.size > 5_000) {
      for (const [k, v] of buckets) if (now >= v.resetAt) buckets.delete(k);
    }
    return { allowed: true, remaining: limit - 1 };
  }

  if (bucket.count >= limit) return { allowed: false, remaining: 0 };
  bucket.count++;
  return { allowed: true, remaining: limit - bucket.count };
}
