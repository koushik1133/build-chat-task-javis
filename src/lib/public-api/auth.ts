import { verifyApiKey } from "@/lib/api-keys";
import { rateLimit } from "@/lib/request-limits";
import { ApiError } from "./envelope";
import { hasScope, type ApiScope } from "./scopes";

/**
 * API-key authentication for /api/v1.
 *
 * Keys are personal (`api_keys.user_id`), so the data scope is the owner's
 * workspace: `dataId === userId` (organizations are keyed by owner_user_id).
 */

export const RATE_LIMIT_PER_MIN = 600;
const WINDOW_MS = 60_000;

export interface ApiPrincipal {
  userId: string;
  /** Org data key; every query must filter by this. */
  dataId: string;
  keyId: string;
  scopes: string[];
  rate: { limit: number; remaining: number; resetAt: number };
}

export function rateLimitHeaders(rate: ApiPrincipal["rate"]): Record<string, string> {
  return {
    "X-RateLimit-Limit": String(rate.limit),
    "X-RateLimit-Remaining": String(Math.max(0, rate.remaining)),
    "X-RateLimit-Reset": String(Math.ceil(rate.resetAt / 1000)),
  };
}

export function bearerToken(req: Request): string | null {
  const header = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1].trim() : null;
}

/**
 * Resolve and authorise the caller. Throws ApiError 401/403/429; the 429
 * carries Retry-After and the X-RateLimit-* headers.
 */
export async function requireApiKey(req: Request, scope: ApiScope | null): Promise<ApiPrincipal> {
  const token = bearerToken(req);
  if (!token) throw ApiError.unauthorized("Send `Authorization: Bearer kh_…` — create a key under Settings → API keys.");
  const verified = await verifyApiKey(token);
  if (!verified) throw ApiError.unauthorized();

  const r = rateLimit(`api:v1:${verified.keyId}`, RATE_LIMIT_PER_MIN, WINDOW_MS);
  const rate = { limit: RATE_LIMIT_PER_MIN, remaining: r.remaining, resetAt: r.resetAt };
  if (!r.allowed) {
    const retry = Math.max(1, Math.ceil((r.resetAt - Date.now()) / 1000));
    throw new ApiError(429, "rate_limited", `Rate limit of ${RATE_LIMIT_PER_MIN} requests per minute exceeded`, undefined, {
      "Retry-After": String(retry),
      ...rateLimitHeaders(rate),
    });
  }

  if (scope && !hasScope(verified.scopes, scope)) {
    throw new ApiError(403, "forbidden", `This API key lacks the "${scope}" scope`, { required: scope, granted: verified.scopes }, rateLimitHeaders(rate));
  }

  return { userId: verified.userId, dataId: verified.userId, keyId: verified.keyId, scopes: verified.scopes, rate };
}
