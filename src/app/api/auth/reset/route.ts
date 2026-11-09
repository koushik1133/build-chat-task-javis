import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { authRateLimitAsync } from "@/lib/request-limits";

const Body = z.object({ email: z.string().email().max(254) });
const GENERIC = "If an account exists for that email, a reset link has been sent.";

/** POST /api/auth/reset — password reset email, rate limited, enumeration-safe. */
export async function POST(req: Request) {
  const limit = await authRateLimitAsync("reset", req);
  if (!limit.allowed) {
    return NextResponse.json({ error: "Too many attempts. Try again later." }, { status: 429 });
  }

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "A valid email is required." }, { status: 400 });

  try {
    const origin = new URL(req.url).origin;
    const appUrl = process.env.NEXT_PUBLIC_APP_URL?.trim() || origin;
    const supabase = await createClient();
    const { error } = await supabase.auth.resetPasswordForEmail(parsed.data.email.trim().toLowerCase(), {
      redirectTo: `${appUrl}/auth/callback?next=${encodeURIComponent("/settings")}`,
    });
    if (error) console.warn("[auth/reset] rejected:", error.status, error.message);
  } catch (err) {
    console.error("[auth/reset] error:", err);
  }
  // Always the same body/status.
  return NextResponse.json({ ok: true, message: GENERIC });
}
