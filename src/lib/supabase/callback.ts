import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { type NextRequest, NextResponse } from "next/server";

type CookieToSet = { name: string; value: string; options?: CookieOptions };

function trimEnv(value: string | undefined): string {
  return value?.trim() ?? "";
}

function safeNext(raw: string | null): string {
  if (!raw) return "/chat";
  try {
    const decoded = decodeURIComponent(raw);
    if (decoded.startsWith("/") && !decoded.startsWith("//")) return decoded;
  } catch {
    // ignore
  }
  return "/chat";
}

/** Public origin for redirects on Cloud Run (not 0.0.0.0:8080). */
export function publicOrigin(request: NextRequest): string {
  if (process.env.NODE_ENV === "development") {
    return request.nextUrl.origin;
  }

  const forwardedHost = request.headers.get("x-forwarded-host");
  if (forwardedHost) {
    const host = forwardedHost.split(",")[0]?.trim();
    if (host && !host.startsWith("0.0.0.0")) {
      const proto = request.headers.get("x-forwarded-proto") ?? "https";
      return `${proto}://${host}`;
    }
  }

  const appUrl = trimEnv(process.env.NEXT_PUBLIC_APP_URL);
  if (appUrl) return appUrl;

  return request.nextUrl.origin;
}

export function publicRedirect(path: string, request: NextRequest): string {
  const next = path.startsWith("/") ? path : `/${path}`;
  return new URL(next, publicOrigin(request)).toString();
}

/**
 * Supabase client for /auth/callback — session cookies MUST be written onto
 * the redirect response or exchangeCodeForSession silently fails in prod.
 */
export function createCallbackClient(
  request: NextRequest,
  response: NextResponse
) {
  return createServerClient(
    trimEnv(process.env.NEXT_PUBLIC_SUPABASE_URL),
    trimEnv(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY),
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (toSet: CookieToSet[]) => {
          toSet.forEach(({ name, value, options }) => {
            request.cookies.set(name, value);
            response.cookies.set(name, value, options);
          });
        },
      },
    }
  );
}
