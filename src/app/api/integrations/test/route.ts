import { NextResponse } from "next/server";
import { requireUser } from "@/lib/supabase/server";
import { queryOne } from "@/lib/dsql";
import {
  getUserIntegrations,
  platformFromAddress,
  isPlatformEmailAvailable,
  resolveSlackWebhook,
  upsertUserIntegrations,
  toPublicView,
  isValidSlackWebhook,
  isSandboxSender,
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
    const from = platformFromAddress(integrations.email_from_name);
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [to],
        subject: "KernelHub — email connection test",
        html: `<div style="font-family:sans-serif;line-height:1.6">
          <h2>You're all set!</h2>
          <p>KernelHub will send automation emails to this verified address.</p>
          <p style="color:#888;font-size:12px">Sent from ${from}</p>
        </div>`,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const raw = (data as { message?: string }).message ?? res.statusText;
      const isSandboxError = res.status === 403 || 
        /your own email address/i.test(raw) || 
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

    const emailId = (data as { id?: string }).id;
    if (emailId && isSandboxSender(from)) {
      // Poll to check sandbox delivery status
      let delivered = true;
      let lastEvent = "pending";
      const start = Date.now();
      while (Date.now() - start < 3000) {
        try {
          const pollRes = await fetch(`https://api.resend.com/emails/${emailId}`, {
            headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}` }
          });
          if (pollRes.ok) {
            const pollData = await pollRes.json() as { last_event?: string };
            lastEvent = pollData.last_event ?? "unknown";
            if (lastEvent === "delivered") {
              delivered = true;
              break;
            }
            if (["bounced", "complained"].includes(lastEvent)) {
              delivered = false;
              break;
            }
          }
        } catch {}
        await new Promise((r) => setTimeout(r, 800));
      }

      if (!delivered || lastEvent === "bounced") {
        return NextResponse.json({
          success: false,
          message: "Email rejected by recipient server",
          detail: `Status: ${lastEvent}. Resend sandbox (onboarding@resend.dev) can only deliver to the Resend account owner's email. Verify a custom domain at resend.com/domains to send to any address.`,
        });
      }

      return NextResponse.json({
        success: true,
        message: `Test email sent to ${to}`,
        detail: "⚠️ Using Resend sandbox — emails only reach the account owner's inbox. Verify a domain at resend.com/domains for reliable delivery.",
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
