import { NextResponse, type NextRequest } from "next/server";
import { rateLimitAsync } from "@/lib/request-limits";
import { cartCookieName } from "./cart";
import { resolveStorefrontBySlug, type PublicStorefront } from "./settings";

/** Shared plumbing for the public /api/shop/[org]/* routes. */

export const NO_STORE = { "Cache-Control": "no-store, max-age=0" } as const;

export function clientIp(req: NextRequest): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "anon";
}

/** Per-ip limiter for the public shop routes; returns a 429 response or null. */
export async function shopRateLimit(req: NextRequest, bucket: string, limit = 120): Promise<NextResponse | null> {
  const { allowed } = await rateLimitAsync(`shop:${bucket}:${clientIp(req)}`, limit, 60_000);
  return allowed ? null : NextResponse.json({ error: "rate_limited" }, { status: 429, headers: NO_STORE });
}

export async function resolveShop(ctx: { params: Promise<{ org: string }> }): Promise<PublicStorefront | null> {
  const { org } = await ctx.params;
  return resolveStorefrontBySlug(org);
}

export function notFound(): NextResponse {
  return NextResponse.json({ error: "not_found" }, { status: 404, headers: NO_STORE });
}

export function readCartToken(req: NextRequest, slug: string): string | null {
  return req.cookies.get(cartCookieName(slug))?.value ?? null;
}

/** Attach the cart cookie: HttpOnly, SameSite=Lax, scoped to the shop path; lifetime follows the storefront's cart TTL. */
export function withCartCookie(res: NextResponse, pub: PublicStorefront, token: string | null): NextResponse {
  if (token) {
    res.cookies.set(cartCookieName(pub.storefront.slug), token, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: pub.storefront.settings.cart_ttl_hours * 3600,
    });
  }
  return res;
}

export function shopError(err: unknown, log: string): NextResponse {
  if (err && typeof err === "object" && "code" in err && (err as { name?: string }).name === "CheckoutError") {
    const e = err as { code: string; message: string; detail?: Record<string, unknown> };
    const status = e.code === "insufficient_stock" || e.code === "unavailable" || e.code === "already_ordered" ? 409 : 400;
    return NextResponse.json({ error: e.code, detail: e.message, ...(e.detail ?? {}) }, { status, headers: NO_STORE });
  }
  if (err && typeof err === "object" && (err as { name?: string }).name === "CartError") {
    const e = err as { code: string; message: string };
    return NextResponse.json({ error: e.code, detail: e.message }, { status: e.code === "out_of_stock" ? 409 : 400, headers: NO_STORE });
  }
  const msg = err instanceof Error ? err.message : "error";
  if (/not found/i.test(msg)) return NextResponse.json({ error: "not_found", detail: msg }, { status: 404, headers: NO_STORE });
  console.error(`[${log}]`, err);
  return NextResponse.json({ error: "internal_error" }, { status: 500, headers: NO_STORE });
}
