import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { authRateLimit } from "@/lib/request-limits";

const Body = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(128),
});

/**
 * POST /api/auth/login — password sign-in through the server so the attempt
 * is rate limited per IP and the session cookie is set server-side.
 */
export async function POST(req: Request) {
  const limit = authRateLimit("login", req);
  if (!limit.allowed) {
    return NextResponse.json({ error: "Too many attempts. Try again later." }, { status: 429 });
  }

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Wrong email or password." }, { status: 400 });
  }

  try {
    const supabase = await createClient();
    const { data, error } = await supabase.auth.signInWithPassword({
      email: parsed.data.email.trim().toLowerCase(),
      password: parsed.data.password,
    });
    if (error || !data.session) {
      // Same message for unknown email, wrong password and unconfirmed email.
      return NextResponse.json({ error: "Wrong email or password." }, { status: 401 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[auth/login] error:", err);
    return NextResponse.json({ error: "Sign in is temporarily unavailable." }, { status: 500 });
  }
}
