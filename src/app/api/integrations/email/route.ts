import { NextResponse } from "next/server";
import { requireUser } from "@/lib/supabase/server";
import {
  confirmEmailVerification,
  startEmailVerification,
  toPublicView,
} from "@/lib/user-integrations";

export async function POST(req: Request) {
  let user;
  try { ({ user } = await requireUser()); }
  catch { return NextResponse.json({ error: "unauthorized" }, { status: 401 }); }

  const { action, email, email_from_name, code } = await req.json();

  if (action === "send-code") {
    if (!email?.trim()) {
      return NextResponse.json({ error: "Email required" }, { status: 400 });
    }
    const result = await startEmailVerification(user.id, email, email_from_name);
    if (!result.ok) {
      return NextResponse.json({ success: false, message: result.error }, { status: 400 });
    }
    return NextResponse.json({
      success: true,
      message: `Verification code sent to ${email.trim().toLowerCase()}`,
    });
  }

  if (action === "verify") {
    if (!code?.trim()) {
      return NextResponse.json({ error: "Code required" }, { status: 400 });
    }
    const result = await confirmEmailVerification(user.id, code);
    if (!result.ok) {
      return NextResponse.json({ success: false, message: result.error }, { status: 400 });
    }
    return NextResponse.json({
      success: true,
      message: "Email verified and connected",
      integrations: toPublicView(result.row ?? null),
    });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
