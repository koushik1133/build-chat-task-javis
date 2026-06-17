import { NextResponse, type NextRequest } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";
import {
  createCallbackClient,
  publicRedirect,
} from "@/lib/supabase/callback";

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  const token_hash = request.nextUrl.searchParams.get("token_hash");
  const type = request.nextUrl.searchParams.get("type") as EmailOtpType | null;
  const next = safeNext(request.nextUrl.searchParams.get("next"));

  try {
    if (code) {
      let response = NextResponse.redirect(publicRedirect(next, request));
      const supabase = createCallbackClient(request, response);
      const { error } = await supabase.auth.exchangeCodeForSession(code);

      if (error) {
        response = NextResponse.redirect(
          publicRedirect(
            `/login?error=${encodeURIComponent(error.message)}`,
            request
          )
        );
      }
      return response;
    }

    if (token_hash && type) {
      let response = NextResponse.redirect(publicRedirect(next, request));
      const supabase = createCallbackClient(request, response);
      const { error } = await supabase.auth.verifyOtp({ type, token_hash });

      if (error) {
        response = NextResponse.redirect(
          publicRedirect(
            `/login?error=${encodeURIComponent(error.message)}`,
            request
          )
        );
      }
      return response;
    }

    return NextResponse.redirect(
      publicRedirect("/login?error=missing_code", request)
    );
  } catch (err) {
    console.error("[auth/callback]", err);
    const message =
      err instanceof Error ? err.message : "Authentication callback failed";
    return NextResponse.redirect(
      publicRedirect(`/login?error=${encodeURIComponent(message)}`, request)
    );
  }
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
