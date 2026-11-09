import { isSafeRelativePath } from "@/lib/safe-next";
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { publicRedirect } from "@/lib/supabase/callback";

type CookieToSet = { name: string; value: string; options?: CookieOptions };

function env(name: string): string {
  return process.env[name]?.trim() ?? "";
}

/** Routes that never require authentication. */
function isPublicPath(path: string) {
  if (path === "/" || path === "/login") return true;
  if (path.startsWith("/auth/")) return true;
  // Public token-scoped surfaces: shared quotes/invoices/pay links, client
  // portal, booking pages and invite acceptance (which handles sign-in itself).
  if (path.startsWith("/p/") || path.startsWith("/book/") || path.startsWith("/invite/")) return true;
  if (path.startsWith("/help/") || path.startsWith("/shop/") || path.startsWith("/u/") || path.startsWith("/join/") || path.startsWith("/track/") || path.startsWith("/s/") || path.startsWith("/reviews/") || path === "/pricing" || path.startsWith("/api/calendar/feed/") || path.startsWith("/m/") || path === "/offline" || path === "/widget-demo" || path === "/sw.js" || path === "/manifest.webmanifest") return true;
  // API routes enforce auth individually (requireUser, cron secret, public webhooks).
  if (path.startsWith("/api/")) return true;
  return false;
}

function forwardRequest(request: NextRequest, path: string) {
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-pathname", path);
  return NextResponse.next({ request: { headers: requestHeaders } });
}

/** Session-bearing pages must never be served from a shared or back/forward cache. */
function denyCaching<T extends NextResponse>(res: T): T {
  res.headers.set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
  res.headers.set("Pragma", "no-cache");
  res.headers.set("Expires", "0");
  return res;
}

/** Expire every Supabase auth cookie present on the request. */
function clearSupabaseCookies<T extends NextResponse>(res: T, request: NextRequest): T {
  for (const cookie of request.cookies.getAll()) {
    if (cookie.name.startsWith("sb-")) {
      res.cookies.set(cookie.name, "", { maxAge: 0, path: "/", sameSite: "lax" });
    }
  }
  return res;
}

const REQUEST_ID_RE = /^[A-Za-z0-9._-]{8,64}$/;

/** Propagate/generate `x-request-id` on the forwarded request and echo it on the response. */
export async function updateSession(request: NextRequest) {
  const incoming = request.headers.get("x-request-id") ?? "";
  const reqId = REQUEST_ID_RE.test(incoming) ? incoming : crypto.randomUUID();
  try { request.headers.set("x-request-id", reqId); } catch { /* immutable headers: the response still carries the id */ }
  const res = await updateSessionInner(request);
  res.headers.set("x-request-id", reqId);
  return res;
}

async function updateSessionInner(request: NextRequest) {
  const path = request.nextUrl.pathname;
  let response = forwardRequest(request, path);

  const supabase = createServerClient(
    env("NEXT_PUBLIC_SUPABASE_URL"),
    env("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (toSet: CookieToSet[]) => {
          toSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = forwardRequest(request, path);
          toSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  let user: { id: string } | null = null;
  try {
    const { data } = await supabase.auth.getUser();
    user = data.user;
  } catch (err) {
    // Treat an auth backend failure as signed-out rather than crashing the edge.
    console.error("[middleware] supabase.auth.getUser threw:", err);
    user = null;
  }

  if (isPublicPath(path)) {
    // Landing on /login straight after sign-out: make sure no stale sb-*
    // cookie can resurrect the session, and never cache this response.
    if (path === "/login" && request.nextUrl.searchParams.get("signed_out") === "1") {
      return denyCaching(clearSupabaseCookies(forwardRequest(request, path), request));
    }
    if (user && path === "/login") {
      const next = request.nextUrl.searchParams.get("next");
      const dest =
        next && isSafeRelativePath(next) && !next.startsWith("/login")
          ? next
          : "/home";
      return NextResponse.redirect(publicRedirect(dest, request));
    }
    return response;
  }

  if (!user) {
    const redirect = NextResponse.redirect(
      publicRedirect(`/login?next=${encodeURIComponent(path + request.nextUrl.search)}`, request)
    );
    return denyCaching(clearSupabaseCookies(redirect, request));
  }

  return denyCaching(response);
}
