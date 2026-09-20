import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";

export async function POST(req: Request) {
  try {
    const rawBody = await req.json().catch(() => null);
    if (!rawBody || typeof rawBody !== "object") return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    const { email, password } = rawBody;
    if (!email || !password) {
      return NextResponse.json({ error: "Email and password are required" }, { status: 400 });
    }

    const adminSupabase = createAdminClient();
    let { data, error } = await adminSupabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });

    if (error && (error.message.toLowerCase().includes("not allowed") || error.status === 403)) {
      const { data: signUpData, error: signUpError } = await adminSupabase.auth.signUp({
        email,
        password,
      });
      data = signUpData;
      error = signUpError;
    }

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }

    return NextResponse.json({ success: true, user: data.user });
  } catch (err) {
    console.error("[auth/signup] error:", err);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
