import { isPushConfigured } from "@/lib/push/vapid";
/**
 * Which outbound channels are wired to a real provider vs. simulated.
 *
 * Simulated channels still write the outbox row with the full body so a
 * developer can read OTPs / invite links from Settings → Outbox.
 */
export const NOTIFICATION_CHANNELS = ["email", "sms", "whatsapp", "in_app", "webhook", "push"] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

export type ChannelMode = "live" | "simulated";

export function isNotificationChannel(v: unknown): v is NotificationChannel {
  return typeof v === "string" && (NOTIFICATION_CHANNELS as readonly string[]).includes(v);
}

function has(name: string): boolean {
  return Boolean(process.env[name]?.trim());
}

export function emailIsLive(): boolean {
  if (has("RESEND_API_KEY")) return true;
  const provider = process.env.EMAIL_PROVIDER;
  if (provider === "gmail") {
    return (has("GMAIL_USER") || has("SMTP_USER")) && (has("GMAIL_APP_PASSWORD") || has("SMTP_PASSWORD"));
  }
  return false;
}

export function twilioIsLive(): boolean {
  return has("TWILIO_ACCOUNT_SID") && has("TWILIO_AUTH_TOKEN") && has("TWILIO_FROM_NUMBER");
}

export function channelStatus(): Record<NotificationChannel, ChannelMode> {
  const twilio: ChannelMode = twilioIsLive() ? "live" : "simulated";
  return {
    email: emailIsLive() ? "live" : "simulated",
    sms: twilio,
    whatsapp: twilio,
    in_app: "live",
    webhook: "live",
    push: isPushConfigured() ? "live" : "simulated",
  };
}
