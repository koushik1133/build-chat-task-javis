import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { NextRequest } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";

type CookieToSet = { name: string; value: string; options?: CookieOptions };

export const dynamic = "force-dynamic";

function env(name: string): string {
  return process.env[name]?.trim() ?? "";
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

async function createRouteClient() {
  const supabaseUrl = env("NEXT_PUBLIC_SUPABASE_URL");
  const supabaseKey = env("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  if (!supabaseUrl || !supabaseKey) {
    throw new Error("Missing Supabase configuration on server");
  }

  const cookieStore = await cookies();
  return createServerClient(supabaseUrl, supabaseKey, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (toSet: CookieToSet[]) => {
        toSet.forEach(({ name, value, options }) => {
          cookieStore.set(name, value, options);
        });
      },
    },
  });
}

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  const token_hash = request.nextUrl.searchParams.get("token_hash");
  const type = request.nextUrl.searchParams.get("type") as EmailOtpType | null;
  const next = safeNext(request.nextUrl.searchParams.get("next"));

  try {
    const supabase = await createRouteClient();

    if (code) {
      const { error } = await supabase.auth.exchangeCodeForSession(code);
      if (error) {
        redirect(`/login?error=${encodeURIComponent(error.message)}`);
      }
      redirect(next);
    }

    if (token_hash && type) {
      const { error } = await supabase.auth.verifyOtp({ type, token_hash });
      if (error) {
        redirect(`/login?error=${encodeURIComponent(error.message)}`);
      }
      redirect(next);
    }

    redirect("/login?error=missing_code");
  } catch (err) {
    // redirect() throws NEXT_REDIRECT — must rethrow
    if (
      err &&
      typeof err === "object" &&
      "digest" in err &&
      String((err as { digest?: string }).digest).startsWith("NEXT_REDIRECT")
    ) {
      throw err;
    }
    console.error("[auth/callback]", err);
    const message =
      err instanceof Error ? err.message : "Authentication callback failed";
    redirect(`/login?error=${encodeURIComponent(message)}`);
  }
}
