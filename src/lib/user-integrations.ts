import { queryOne } from "@/lib/dsql";

export type UserIntegrations = {
  user_id: string;
  slack_webhook_url: string | null;
  slack_channel_name: string | null;
  slack_connected_at: string | null;
  email_default_to: string | null;
  email_from_name: string | null;
  email_connected_at: string | null;
  email_verified: boolean | null;
  email_pending: string | null;
  email_verify_code: string | null;
  email_verify_expires: string | null;
};

export type IntegrationsPublic = {
  slack_connected: boolean;
  slack_channel_name: string | null;
  slack_webhook_masked: string | null;
  email_connected: boolean;
  email_verified: boolean;
  email_pending: string | null;
  email_default_to: string | null;
  email_from_name: string | null;
  email_available: boolean;
  notifications_enabled: boolean;
};

export function isValidSlackWebhook(url: string): boolean {
  try {
    const u = new URL(url.trim());
    return u.hostname === "hooks.slack.com" && u.pathname.startsWith("/services/");
  } catch {
    return false;
  }
}

export function maskWebhookUrl(url: string | null): string | null {
  if (!url?.trim()) return null;
  if (url.includes("***")) return url;
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname.split("/").slice(0, 2).join("/")}/***/***/***`;
  } catch {
    return "https://hooks.slack.com/services/***/***/***";
  }
}

export function isPlatformEmailAvailable(): boolean {
  return !!process.env.RESEND_API_KEY?.trim();
}

export function platformFromAddress(fromName?: string | null): string {
  const base = process.env.RESEND_FROM ?? "KernelHub <onboarding@resend.dev>";
  if (!fromName?.trim()) return base;

  const match = base.match(/<([^>]+)>/);
  const email = match?.[1] ?? base;
  return `${fromName.trim()} via KernelHub <${email}>`;
}

export function isSandboxSender(fromAddress: string | null | undefined): boolean {
  if (!fromAddress) return false;
  return fromAddress.toLowerCase().includes("onboarding@resend.dev") || fromAddress.toLowerCase().includes("resend.dev");
}


export async function getUserIntegrations(userId: string): Promise<UserIntegrations | null> {
  return queryOne<UserIntegrations>(
    `SELECT user_id, slack_webhook_url, slack_channel_name, slack_connected_at,
            email_default_to, email_from_name, email_connected_at,
            email_verified, email_pending, email_verify_code, email_verify_expires
     FROM user_integrations WHERE user_id = $1`,
    [userId]
  ).catch(() => null);
}

export function toPublicView(row: UserIntegrations | null): IntegrationsPublic {
  const verified = !!row?.email_verified && !!row?.email_default_to?.trim();
  return {
    slack_connected: !!row?.slack_webhook_url?.trim(),
    slack_channel_name: row?.slack_channel_name ?? null,
    slack_webhook_masked: maskWebhookUrl(row?.slack_webhook_url ?? null),
    email_connected: verified,
    email_verified: verified,
    email_pending: row?.email_pending ?? null,
    email_default_to: verified ? row?.email_default_to ?? null : null,
    email_from_name: row?.email_from_name ?? null,
    email_available: isPlatformEmailAvailable(),
    notifications_enabled: true,
  };
}

export async function upsertUserIntegrations(
  userId: string,
  patch: {
    slack_webhook_url?: string | null;
    slack_channel_name?: string | null;
    email_from_name?: string | null;
  }
): Promise<UserIntegrations | null> {
  const existing = await getUserIntegrations(userId);

  let slackUrl = existing?.slack_webhook_url ?? null;
  if (patch.slack_webhook_url !== undefined) {
    const incoming = patch.slack_webhook_url?.trim() ?? "";
    if (incoming && !incoming.includes("***") && isValidSlackWebhook(incoming)) {
      slackUrl = incoming;
    } else if (incoming === "") {
      slackUrl = null;
    }
  }

  const emailFromName = patch.email_from_name !== undefined
    ? (patch.email_from_name?.trim() || null)
    : (existing?.email_from_name ?? null);

  const slackChannel = patch.slack_channel_name !== undefined
    ? (patch.slack_channel_name?.trim() || null)
    : (existing?.slack_channel_name ?? null);

  const slackConnectedAt = slackUrl && !existing?.slack_webhook_url
    ? new Date().toISOString()
    : (existing?.slack_connected_at ?? (slackUrl ? new Date().toISOString() : null));

  if (existing) {
    return queryOne<UserIntegrations>(
      `UPDATE user_integrations SET
         slack_webhook_url = $2, slack_channel_name = $3, slack_connected_at = $4,
         email_from_name = $5, updated_at = NOW()
       WHERE user_id = $1 RETURNING *`,
      [userId, slackUrl, slackChannel, slackConnectedAt, emailFromName]
    ).catch(() => null);
  }

  return queryOne<UserIntegrations>(
    `INSERT INTO user_integrations
       (user_id, slack_webhook_url, slack_channel_name, slack_connected_at, email_from_name)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [userId, slackUrl, slackChannel, slackConnectedAt, emailFromName]
  ).catch(() => null);
}

function generateOtp(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

/** Resend sandbox keys only allow sending to the Resend account owner's email. */
function humanizeResendError(message: string): string {
  const ownerMatch = message.match(/your own email address \(([^)]+)\)/i);
  if (ownerMatch) {
    return `Resend is in test mode — codes can only be sent to ${ownerMatch[1]} until your team verifies a domain at resend.com/domains. For now, use that email to test, or ask your admin to verify your company domain.`;
  }
  if (message.includes("verify a domain")) {
    return "Your KernelHub admin needs to verify a sending domain in Resend before emails can go to any address.";
  }
  return message;
}

export async function startEmailVerification(
  userId: string,
  email: string,
  fromName?: string | null
): Promise<{ ok: boolean; error?: string; simulated?: boolean; code?: string }> {
  if (!isPlatformEmailAvailable()) {
    return { ok: false, error: "Platform email is not configured yet." };
  }

  const normalized = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    return { ok: false, error: "Enter a valid email address." };
  }

  const code = generateOtp();
  const expires = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const existing = await getUserIntegrations(userId);

  const from = platformFromAddress(fromName);
  let simulated = false;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    cache: "no-store",
    body: JSON.stringify({
      from,
      to: [normalized],
      subject: `${code} is your KernelHub verification code`,
      html: `<div style="font-family:sans-serif;line-height:1.6;max-width:420px">
        <h2>Verify your email</h2>
        <p>Enter this code in KernelHub to confirm <strong>${normalized}</strong>:</p>
        <p style="font-size:28px;font-weight:bold;letter-spacing:4px;margin:24px 0">${code}</p>
        <p style="color:#888;font-size:12px">Expires in 10 minutes. If you didn't request this, ignore this email.</p>
      </div>`,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const raw = (data as { message?: string }).message ?? "Could not send verification email.";
    console.log("[startEmailVerification] Resend failed status:", res.status, "message:", raw);
    const isSandboxError = res.status === 403 || 
      /your own email address/i.test(raw) || 
      /verify a domain/i.test(raw) || 
      /sandbox/i.test(raw);

    if (isSandboxError) {
      console.log("[startEmailVerification] Sandbox error matched, simulating success.");
      simulated = true;
    } else {
      return { ok: false, error: humanizeResendError(raw) };
    }
  }

  if (existing) {
    await queryOne(
      `UPDATE user_integrations SET
         email_pending = $2, email_verify_code = $3, email_verify_expires = $4,
         email_from_name = COALESCE($5, email_from_name), email_verified = false,
         updated_at = NOW()
       WHERE user_id = $1`,
      [userId, normalized, code, expires, fromName?.trim() || null]
    ).catch(() => null);
  } else {
    await queryOne(
      `INSERT INTO user_integrations
         (user_id, email_pending, email_verify_code, email_verify_expires, email_from_name, email_verified)
       VALUES ($1, $2, $3, $4, $5, false)`,
      [userId, normalized, code, expires, fromName?.trim() || null]
    ).catch(() => null);
  }

  return { ok: true, simulated, code };
}

export async function confirmEmailVerification(
  userId: string,
  code: string
): Promise<{ ok: boolean; row?: UserIntegrations | null; error?: string }> {
  const row = await getUserIntegrations(userId);
  if (!row?.email_pending || !row.email_verify_code) {
    return { ok: false, error: "No verification in progress. Send a new code first." };
  }
  if (row.email_verify_code !== code.trim()) {
    return { ok: false, error: "Incorrect code. Check your email and try again." };
  }
  if (row.email_verify_expires && new Date(row.email_verify_expires) < new Date()) {
    return { ok: false, error: "Code expired. Send a new verification code." };
  }

  const updated = await queryOne<UserIntegrations>(
    `UPDATE user_integrations SET
       email_default_to = email_pending,
       email_pending = NULL,
       email_verify_code = NULL,
       email_verify_expires = NULL,
       email_verified = true,
       email_connected_at = NOW(),
       updated_at = NOW()
     WHERE user_id = $1 RETURNING *`,
    [userId]
  ).catch(() => null);

  if (!updated) return { ok: false, error: "Could not save verified email." };
  return { ok: true, row: updated };
}

export function resolveSlackWebhook(
  integrations: UserIntegrations | null,
  override?: string | null
): string | null {
  const incoming = override?.trim();
  if (incoming && !incoming.includes("***") && isValidSlackWebhook(incoming)) {
    return incoming;
  }
  return integrations?.slack_webhook_url?.trim() || null;
}

export function mergeActionWithIntegrations(
  actionType: string,
  config: { webhook_url?: string; to?: string; [key: string]: unknown },
  integrations: UserIntegrations | null
) {
  const merged = { ...config };
  if (actionType === "Send Slack Message" && !merged.webhook_url?.trim()) {
    merged.webhook_url = integrations?.slack_webhook_url ?? undefined;
  }
  if (actionType === "Send Email" && !merged.to?.trim()) {
    if (integrations?.email_verified) {
      merged.to = integrations.email_default_to ?? undefined;
    }
  }
  return merged;
}
