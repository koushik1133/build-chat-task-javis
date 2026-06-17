import { NextResponse } from "next/server";
import { requireUser } from "@/lib/supabase/server";
import {
  getUserIntegrations,
  toPublicView,
  upsertUserIntegrations,
} from "@/lib/user-integrations";

export async function GET() {
  let user;
  try { ({ user } = await requireUser()); }
  catch { return NextResponse.json({ error: "unauthorized" }, { status: 401 }); }

  const row = await getUserIntegrations(user.id);
  return NextResponse.json({ integrations: toPublicView(row) });
}

export async function PATCH(req: Request) {
  let user;
  try { ({ user } = await requireUser()); }
  catch { return NextResponse.json({ error: "unauthorized" }, { status: 401 }); }

  const body = await req.json();
  const row = await upsertUserIntegrations(user.id, {
    slack_webhook_url: body.slack_webhook_url,
    slack_channel_name: body.slack_channel_name,
    email_from_name: body.email_from_name,
  });

  if (!row) {
    return NextResponse.json({
      error: "Failed to save connections",
      detail: "Make sure the user_integrations table exists in your database.",
    }, { status: 500 });
  }

  return NextResponse.json({ integrations: toPublicView(row) });
}
