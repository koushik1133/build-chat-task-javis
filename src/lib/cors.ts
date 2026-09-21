/**
 * CORS allow-listing for public widget / lead endpoints.
 *
 * Resolution order for allowed origins:
 *   1. per-site `sites.allowed_origins` (JSON array or comma-separated list)
 *   2. PUBLIC_WIDGET_ORIGINS env (comma-separated)
 *   3. nothing configured -> wildcard (these endpoints are anonymous by design;
 *      an empty allow-list must not silently break every existing embed).
 */
import { queryOne } from "@/lib/dsql";

export interface CorsOptions {
  allowedOrigins: readonly string[];
  methods?: string;
  headers?: string;
}

function normaliseOrigin(o: string): string | null {
  const t = o.trim();
  if (!t) return null;
  if (t === "*") return "*";
  try {
    return new URL(t.includes("://") ? t : `https://${t}`).origin.toLowerCase();
  } catch {
    return null;
  }
}

/** Parse a stored origin list (JSON array, or comma/newline separated). */
export function parseOriginList(raw: string | null | undefined): string[] {
  if (!raw) return [];
  let parts: string[] = [];
  const t = raw.trim();
  if (t.startsWith("[")) {
    try {
      const arr = JSON.parse(t);
      if (Array.isArray(arr)) parts = arr.filter((x): x is string => typeof x === "string");
    } catch {
      parts = [];
    }
  } else {
    parts = t.split(/[,\n]/);
  }
  const out = new Set<string>();
  for (const p of parts) {
    const n = normaliseOrigin(p);
    if (n) out.add(n);
  }
  return [...out];
}

export function envWidgetOrigins(): string[] {
  return parseOriginList(process.env.PUBLIC_WIDGET_ORIGINS);
}

/** Decide which `Access-Control-Allow-Origin` (if any) a request gets. */
export function resolveAllowedOrigin(
  requestOrigin: string | null,
  allowedOrigins: readonly string[]
): string | null {
  const list = allowedOrigins.map((o) => normaliseOrigin(o)).filter((o): o is string => !!o);
  if (list.length === 0 || list.includes("*")) return "*";
  if (!requestOrigin) return null;
  const req = normaliseOrigin(requestOrigin);
  if (!req) return null;
  return list.includes(req) ? req : null;
}

export function corsHeadersFor(req: Request, opts: CorsOptions): Record<string, string> {
  const allow = resolveAllowedOrigin(req.headers.get("origin"), opts.allowedOrigins);
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": opts.methods ?? "POST, OPTIONS",
    "Access-Control-Allow-Headers": opts.headers ?? "Content-Type",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
  if (allow) headers["Access-Control-Allow-Origin"] = allow;
  return headers;
}

/** Preflight response: 204 with the computed CORS headers. */
export function corsPreflight(req: Request, opts: CorsOptions): Response {
  return new Response(null, { status: 204, headers: corsHeadersFor(req, opts) });
}

/** Origins a site accepts: stored per-site list, falling back to env. */
export async function siteAllowedOrigins(siteId: string): Promise<string[]> {
  let stored: string[] = [];
  try {
    const row = await queryOne<{ allowed_origins: string | null }>(
      `SELECT allowed_origins FROM sites WHERE id = $1`,
      [siteId]
    );
    stored = parseOriginList(row?.allowed_origins);
  } catch {
    // Column may not exist yet (migration pending) — fall back to env.
    stored = [];
  }
  return stored.length ? stored : envWidgetOrigins();
}
