import nodemailer from "nodemailer";

/**
 * A From display name goes inside a quoted header phrase: strip quotes, angle
 * brackets, commas/semicolons and line breaks so a value like `x" <ceo@victim>`
 * cannot break out of the phrase, add an address or inject a header.
 */
export function safeDisplayName(name: string | null | undefined): string {
  return (name ?? "").replace(/["<>\\\r\n,;:]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
}

export type EmailPayload = {
  to: string;
  subject: string;
  html: string;
  fromName?: string | null;
  /** Extra SMTP headers (e.g. List-Unsubscribe). */
  headers?: Record<string, string> | null;
  replyTo?: string | null;
};

export type SendResult = {
  success: boolean;
  message: string;
  detail?: string;
};

export async function sendEmailUnified({
  to,
  subject,
  html,
  fromName,
  headers,
  replyTo,
}: EmailPayload): Promise<SendResult> {
  const provider = process.env.EMAIL_PROVIDER || "resend";

  if (provider === "gmail") {
    const gmailUser = process.env.GMAIL_USER || process.env.SMTP_USER;
    const gmailPass = process.env.GMAIL_APP_PASSWORD || process.env.SMTP_PASSWORD;

    if (!gmailUser || !gmailPass) {
      return {
        success: false,
        message: "Gmail SMTP not configured",
        detail: "Please define GMAIL_USER and GMAIL_APP_PASSWORD in environment variables.",
      };
    }

    const name = safeDisplayName(fromName) || "Javis";
    const fromAddress = `"${name}" <${gmailUser}>`;

    try {
      const transporter = nodemailer.createTransport({
        service: "gmail",
        auth: {
          user: gmailUser,
          pass: gmailPass,
        },
      });

      const info = await transporter.sendMail({
        from: fromAddress,
        to,
        subject,
        html,
        ...(headers ? { headers } : {}),
        ...(replyTo ? { replyTo } : {}),
      });

      console.log(`[Gmail SMTP] Email sent successfully to ${to}:`, info.messageId);
      return {
        success: true,
        message: `Email sent via Gmail to ${to}`,
      };
    } catch (err) {
      console.error("[Gmail SMTP Error]", err);
      return {
        success: false,
        message: "Gmail send failed",
        detail: (err as Error).message,
      };
    }
  }

  // Fallback to Resend
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    return {
      success: false,
      message: "Email not enabled",
      detail: "Define RESEND_API_KEY to enable platform email.",
    };
  }

  // Helper from platformFromAddress matching logic
  const base = process.env.RESEND_FROM ?? "KernelHub <onboarding@resend.dev>";
  let fromAddress = base;
  const safeName = safeDisplayName(fromName);
  if (safeName) {
    const match = base.match(/<([^>]+)>/);
    const email = match?.[1] ?? base;
    fromAddress = `${safeName} via KernelHub <${email}>`;
  }

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: fromAddress,
        to: [to],
        subject,
        html,
        ...(headers ? { headers } : {}),
        ...(replyTo ? { reply_to: replyTo } : {}),
      }),
    });
    const data = (await res.json().catch(() => ({}))) as { id?: string; message?: string };

    if (!res.ok) {
      const raw = data.message ?? res.statusText;
      return { success: false, message: "Resend failed", detail: raw };
    }

    return {
      success: true,
      message: `Email sent via Resend to ${to}`,
    };
  } catch (err) {
    return {
      success: false,
      message: "Resend failed",
      detail: (err as Error).message,
    };
  }
}
