import { isSafeRelativePath } from "@/lib/safe-next";
import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { authRateLimitAsync, clientIp } from "@/lib/request-limits";
import { verifyTurnstile } from "@/lib/auth/turnstile";
import { passwordPolicyError } from "@/lib/auth/password-policy";

const Body = z.object({
  email: z.string().email().max(254),
  password: z.string().max(128),
  turnstileToken: z.string().optional(),
  next: z.string().optional(),
});

const GENERIC = "If that email can be registered, a confirmation link has been sent.";

function safeNext(raw?: string): string {
  if (raw && isSafeRelativePath(raw)) return raw;
  return "/home";
}

/**
 * POST /api/auth/signup — email + password registration with confirmation.
 * Responses are intentionally generic so callers cannot enumerate accounts.
 */
export async function POST(req: Request) {
  const limit = await authRateLimitAsync("signup", req);
  if (!limit.allowed) {
    return NextResponse.json({ error: "Too many attempts. Try again later." }, { status: 429 });
  }

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Email and password are required." }, { status: 400 });
  }
  const email = parsed.data.email.trim().toLowerCase();
  const { password } = parsed.data;

  const policy = passwordPolicyError(password, email);
  if (policy) return NextResponse.json({ error: policy }, { status: 400 });

  if (!(await verifyTurnstile(parsed.data.turnstileToken, clientIp(req)))) {
    return NextResponse.json({ error: "Verification failed. Please try again." }, { status: 400 });
  }

  try {
    const origin = new URL(req.url).origin;
    const appUrl = process.env.NEXT_PUBLIC_APP_URL?.trim() || origin;
    const supabase = await createClient();
    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: `${appUrl}/auth/callback?next=${encodeURIComponent(safeNext(parsed.data.next))}`,
      },
    });
    if (error) {
      // Log server-side; never echo Supabase's message (it reveals whether the email exists).
      console.warn("[auth/signup] rejected:", error.status, error.message);
      if (error.status === 429) {
        return NextResponse.json({ error: "Too many attempts. Try again later." }, { status: 429 });
      }
    }
    return NextResponse.json({ ok: true, message: GENERIC });
  } catch (err) {
    console.error("[auth/signup] error:", err);
    return NextResponse.json({ error: "Sign up is temporarily unavailable." }, { status: 500 });
  }
}
