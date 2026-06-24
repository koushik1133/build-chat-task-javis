import nodemailer from "nodemailer";

export type EmailPayload = {
  to: string;
  subject: string;
  html: string;
  fromName?: string | null;
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

    const name = fromName?.trim() || "Javis";
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
  if (fromName?.trim()) {
    const match = base.match(/<([^>]+)>/);
    const email = match?.[1] ?? base;
    fromAddress = `${fromName.trim()} via KernelHub <${email}>`;
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
