import { NextResponse } from "next/server";
import { requireUser } from "@/lib/supabase/server";
import { sendEmailUnified } from "@/lib/email-sender";
import { queryOne } from "@/lib/dsql";
import {
  getUserIntegrations,
  isPlatformEmailAvailable,
  resolveSlackWebhook,
  upsertUserIntegrations,
  toPublicView,
  isValidSlackWebhook,
} from "@/lib/user-integrations";

export async function POST(req: Request) {
  let user;
  try { ({ user } = await requireUser()); }
  catch { return NextResponse.json({ error: "unauthorized" }, { status: 401 }); }

  const body = await req.json();
  const { type } = body;
  let integrations = await getUserIntegrations(user.id);

  if (type === "slack") {
    const incoming = body.slack_webhook_url?.trim();
    if (incoming && !incoming.includes("***") && isValidSlackWebhook(incoming)) {
      const saved = await upsertUserIntegrations(user.id, {
        slack_webhook_url: incoming,
        slack_channel_name: body.slack_channel_name,
      });
      if (!saved) {
        return NextResponse.json({
          success: false,
          message: "Could not save Slack connection",
          detail: "Database error — ensure user_integrations table exists, then try again.",
        });
      }
      integrations = saved;
    }

    const url = resolveSlackWebhook(integrations, incoming);
    if (!url) {
      return NextResponse.json({
        success: false,
        message: "Paste your Slack webhook URL, then click Connect & test Slack.",
      });
    }

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "✅ *KernelHub is connected!* You'll receive automation alerts in this channel.",
      }),
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      return NextResponse.json({ success: false, message: "Slack test failed", detail: errBody.slice(0, 200) });
    }
    return NextResponse.json({
      success: true,
      message: "Slack connected — test message sent to your channel",
      integrations: toPublicView(integrations),
    });
  }

  if (type === "email") {
    if (!isPlatformEmailAvailable()) {
      return NextResponse.json({
        success: false,
        message: "Email is not enabled yet",
        detail: "Your KernelHub admin needs to configure the platform email (one-time setup).",
      });
    }
    if (!integrations?.email_verified || !integrations.email_default_to?.trim()) {
      return NextResponse.json({
        success: false,
        message: "Verify your email first",
        detail: "Send a verification code and enter it before testing.",
      });
    }
    const to = integrations.email_default_to.trim();
    const emailRes = await sendEmailUnified({
      to,
      subject: "KernelHub — email connection test",
      html: `<div style="font-family:sans-serif;line-height:1.6">
        <h2>You're all set!</h2>
        <p>KernelHub will send automation emails to this verified address.</p>
      </div>`,
      fromName: integrations.email_from_name,
    });

    if (!emailRes.success) {
      const raw = emailRes.detail ?? emailRes.message;
      const isSandboxError = /your own email address/i.test(raw) || 
        /verify a domain/i.test(raw) || 
        /sandbox/i.test(raw);

      if (isSandboxError) {
        return NextResponse.json({
          success: true,
          message: `Test email simulated for ${to}`,
          detail: "⚠️ Sandbox Mode: Since this email address is not verified in Resend, we simulated the test email. Real emails will only reach shagantikoushik@gmail.com until you verify your domain in Resend.",
        });
      }

      return NextResponse.json({
        success: false,
        message: "Email test failed",
        detail: raw,
      });
    }

    return NextResponse.json({ success: true, message: `Test email sent to ${to}` });
  }

  if (type === "notification") {
    const row = await queryOne<{ id: string; title: string; body: string | null; read: boolean; created_at: string }>(
      `INSERT INTO notifications (user_id, title, body) VALUES ($1, $2, $3)
       RETURNING id, title, body, read, created_at`,
      [user.id, "KernelHub connection test", "Website notifications are working — check the bell icon."]
    ).catch(() => null);
    if (!row) {
      return NextResponse.json({ success: false, message: "Failed to create notification" });
    }
    return NextResponse.json({
      success: true,
      message: "Test notification created — check the bell icon",
      notification: row,
    });
  }

  return NextResponse.json({ error: "Unknown test type" }, { status: 400 });
}
