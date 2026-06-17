import { NextResponse } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";

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

/** Absolute redirect URL that works on Cloud Run (uses x-forwarded-host in prod). */
function redirectUrl(path: string, request: Request): string {
  const { origin } = new URL(request.url);
  const next = path.startsWith("/") ? path : `/${path}`;

  if (process.env.NODE_ENV === "development") {
    return `${origin}${next}`;
  }

  const forwardedHost = request.headers.get("x-forwarded-host");
  if (forwardedHost) {
    const host = forwardedHost.split(",")[0]?.trim();
    if (host && !host.startsWith("0.0.0.0")) {
      const proto = request.headers.get("x-forwarded-proto") ?? "https";
      return `${proto}://${host}${next}`;
    }
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "");
  if (appUrl) return `${appUrl}${next}`;

  return `${origin}${next}`;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const token_hash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;
  const next = safeNext(searchParams.get("next"));

  const supabase = await createClient();

  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      return NextResponse.redirect(redirectUrl(next, request));
    }
    return NextResponse.redirect(
      redirectUrl(`/login?error=${encodeURIComponent(error.message)}`, request)
    );
  }

  if (token_hash && type) {
    const { error } = await supabase.auth.verifyOtp({ type, token_hash });
    if (!error) {
      return NextResponse.redirect(redirectUrl(next, request));
    }
    return NextResponse.redirect(
      redirectUrl(`/login?error=${encodeURIComponent(error.message)}`, request)
    );
  }

  return NextResponse.redirect(redirectUrl("/login?error=missing_code", request));
}
