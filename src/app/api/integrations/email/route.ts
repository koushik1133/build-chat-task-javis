import { NextResponse } from "next/server";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import {
  confirmEmailVerification,
  startEmailVerification,
  toPublicView,
} from "@/lib/user-integrations";

export async function POST(req: Request) {
  let scope;
  try { scope = await requireScope({ area: "settings", edit: true }); }
  catch (err) { return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 }); }

  const rawBody = await req.json().catch(() => null);
  if (!rawBody || typeof rawBody !== "object") return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  const { action, email, email_from_name, code } = rawBody;

  if (action === "send-code") {
    if (!email?.trim()) {
      return NextResponse.json({ error: "Email required" }, { status: 400 });
    }
    const result = await startEmailVerification(scope.dataId, email, email_from_name);
    if (!result.ok) {
      return NextResponse.json({ success: false, message: result.error }, { status: 400 });
    }
    return NextResponse.json({
      success: true,
      message: result.simulated
        ? `[Sandbox Simulation] Verification code is: ${result.code}`
        : `Verification code sent to ${email.trim().toLowerCase()}`,
      simulated: result.simulated,
      code: result.simulated ? result.code : undefined,
    });
  }

  if (action === "verify") {
    if (!code?.trim()) {
      return NextResponse.json({ error: "Code required" }, { status: 400 });
    }
    const result = await confirmEmailVerification(scope.dataId, code);
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
