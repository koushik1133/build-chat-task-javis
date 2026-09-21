import { NextResponse } from "next/server";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import {
  getUserIntegrations,
  toPublicView,
  upsertUserIntegrations,
} from "@/lib/user-integrations";

export async function GET() {
  let scope;
  try { scope = await requireScope({ area: "settings", edit: false }); }
  catch (err) { return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 }); }

  const row = await getUserIntegrations(scope.dataId);
  return NextResponse.json({ integrations: toPublicView(row) });
}

export async function PATCH(req: Request) {
  let scope;
  try { scope = await requireScope({ area: "settings", edit: true }); }
  catch (err) { return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 }); }

  const body: unknown = await req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "Request body must be a JSON object." }, { status: 400 });
  }
  const b = body as Record<string, unknown>;
  // Only forward well-typed fields; anything else is treated as "not provided"
  // so it keeps the stored value rather than overwriting it with garbage.
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  const bool = (v: unknown) => (typeof v === "boolean" ? v : undefined);

  const row = await upsertUserIntegrations(scope.dataId, {
    slack_webhook_url: str(b.slack_webhook_url),
    slack_channel_name: str(b.slack_channel_name),
    email_from_name: str(b.email_from_name),
    twilio_from_number: str(b.twilio_from_number),
    messaging_auto_reply: bool(b.messaging_auto_reply),
    upload_post_profile: str(b.upload_post_profile),
  });

  if (!row) {
    return NextResponse.json({
      error: "Failed to save connections",
      detail: "Make sure the user_integrations table exists in your database.",
    }, { status: 500 });
  }

  return NextResponse.json({ integrations: toPublicView(row) });
}
