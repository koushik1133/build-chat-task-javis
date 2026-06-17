import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { type NextRequest, NextResponse } from "next/server";

type CookieToSet = { name: string; value: string; options?: CookieOptions };

function env(name: string): string {
  return process.env[name]?.trim() ?? "";
}

/** Public origin for redirects on Cloud Run (not 0.0.0.0:8080). */
export function publicOrigin(request: NextRequest): string {
  const forwardedHost = request.headers.get("x-forwarded-host");
  if (forwardedHost) {
    const host = forwardedHost.split(",")[0]?.trim();
    if (host && !host.startsWith("0.0.0.0")) {
      const proto = request.headers.get("x-forwarded-proto") ?? "https";
      return `${proto}://${host}`;
    }
  }

  const appUrl = env("NEXT_PUBLIC_APP_URL");
  if (appUrl) return appUrl;

  if (process.env.NODE_ENV === "development") {
    return request.nextUrl.origin;
  }

  return request.nextUrl.origin;
}

export function publicRedirect(path: string, request: NextRequest): string {
  const next = path.startsWith("/") ? path : `/${path}`;
  return new URL(next, publicOrigin(request)).toString();
}
