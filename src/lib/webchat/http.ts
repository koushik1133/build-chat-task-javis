import { NextResponse } from "next/server";
import { z } from "zod";
import { corsHeadersFor, corsPreflight, siteAllowedOrigins } from "@/lib/cors";
import { clientIp, rateLimitAsync, readCappedText } from "@/lib/request-limits";

/** Shared plumbing for the anonymous /api/widget/** routes. */

export const WIDGET_CORS = { methods: "GET, POST, PATCH, OPTIONS", headers: "Content-Type, Authorization" };

export function isUuid(v: string): boolean {
  return z.string().uuid().safeParse(v).success;
}

export async function widgetCors(req: Request, siteId: string): Promise<Record<string, string>> {
  const allowedOrigins = isUuid(siteId) ? await siteAllowedOrigins(siteId) : [];
  return corsHeadersFor(req, { allowedOrigins, ...WIDGET_CORS });
}

export async function widgetPreflight(req: Request, siteId: string): Promise<Response> {
  const allowedOrigins = isUuid(siteId) ? await siteAllowedOrigins(siteId) : [];
  return corsPreflight(req, { allowedOrigins, ...WIDGET_CORS });
}

export function withHeaders<T extends Response>(res: T, headers: Record<string, string>): T {
  for (const [k, v] of Object.entries(headers)) res.headers.set(k, v);
  return res;
}

export function jsonWith(headers: Record<string, string>, body: unknown, status = 200, extra: Record<string, string> = {}): NextResponse {
  return withHeaders(NextResponse.json(body, { status, headers: extra }), headers);
}

/** Parse a capped JSON body with a strict zod schema. Returns a response on failure. */
export async function parseBody<T>(req: Request, schema: z.ZodType<T>, cors: Record<string, string>, maxBytes = 16_384): Promise<{ data: T } | { res: NextResponse }> {
  const raw = await readCappedText(req, maxBytes);
  if (raw === null) return { res: jsonWith(cors, { error: "payload_too_large" }, 413) };
  let json: unknown;
  try {
    json = JSON.parse(raw || "{}");
  } catch {
    return { res: jsonWith(cors, { error: "invalid_json" }, 400) };
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) return { res: jsonWith(cors, { error: "invalid_payload", detail: parsed.error.flatten() }, 400) };
  return { data: parsed.data };
}

/**
 * Bearer token from `Authorization: Bearer …`. `?token=` is accepted only when
 * `allowQuery` is set (the SSE stream, where EventSource cannot send headers);
 * everywhere else a token in the URL would land in proxy/CDN logs for nothing.
 */
export function sessionTokenFrom(req: Request, opts: { allowQuery?: boolean } = {}): string | null {
  const auth = req.headers.get("authorization");
  if (auth?.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return opts.allowQuery ? new URL(req.url).searchParams.get("token") : null;
}

export interface LimitRule {
  key: string;
  limit: number;
  windowMs: number;
}

/** Apply several limits; 429 with Retry-After when any trips. */
export async function enforceLimits(cors: Record<string, string>, rules: LimitRule[]): Promise<NextResponse | null> {
  for (const r of rules) {
    const res = await rateLimitAsync(r.key, r.limit, r.windowMs);
    if (!res.allowed) return jsonWith(cors, { error: "rate_limited" }, 429, { "Retry-After": String(Math.max(1, Math.ceil(r.windowMs / 1000))) });
  }
  return null;
}

export { clientIp };
