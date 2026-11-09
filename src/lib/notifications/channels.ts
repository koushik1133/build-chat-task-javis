import { emailIsLive, twilioIsLive, type NotificationChannel } from "./status";
import { outboundUrlRefusal } from "@/lib/webhooks/url";

/**
 * Per-channel senders. Each returns `sent` (a real provider accepted it),
 * `simulated` (no provider configured — row keeps the body for dev inspection)
 * or throws on a provider error.
 */

export interface OutboundMessage {
  channel: NotificationChannel;
  recipient: string;
  subject: string | null;
  body: string | null;
  data: Record<string, unknown> | null;
  /** Org data id the row belongs to (branding lookups). Internal: never forwarded to third parties. */
  ownerId?: string | null;
}

export type SendOutcome = { status: "sent" | "simulated"; providerId?: string };

type Sender = (msg: OutboundMessage) => Promise<SendOutcome>;

const WEBHOOK_TIMEOUT_MS = 5_000;

async function sendEmail(msg: OutboundMessage): Promise<SendOutcome> {
  if (!emailIsLive()) return { status: "simulated" };
  const { sendEmailUnified } = await import("@/lib/email-sender");
  const ownerId = typeof msg.ownerId === "string" && msg.ownerId ? msg.ownerId : null;
  const rawHtml = msg.body ?? "";
  const { wrapBrandedEmail } = await import("@/lib/branding");
  const html = ownerId ? await wrapBrandedEmail(ownerId, rawHtml) : rawHtml;
  const result = await sendEmailUnified({
    to: msg.recipient,
    subject: msg.subject ?? "(no subject)",
    html: /<[a-z][\s\S]*>/i.test(html) ? html : `<pre style="font-family:inherit;white-space:pre-wrap">${escapeHtml(html)}</pre>`,
    fromName: typeof msg.data?.fromName === "string" ? msg.data.fromName : null,
    headers: extraHeaders(msg.data),
    replyTo: typeof msg.data?.replyTo === "string" ? msg.data.replyTo : null,
  });
  if (!result.success) throw new Error(result.detail ?? result.message);
  return { status: "sent" };
}

/** `data.headers`: string→string map of extra mail headers (List-Unsubscribe etc.). */
function extraHeaders(data: Record<string, unknown> | null): Record<string, string> | null {
  const h = data?.headers;
  if (!h || typeof h !== "object" || Array.isArray(h)) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h as Record<string, unknown>)) if (typeof v === "string" && /^[A-Za-z0-9-]+$/.test(k)) out[k] = v.replace(/[\r\n]/g, " ").slice(0, 1000);
  return Object.keys(out).length ? out : null;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}

async function sendTwilio(msg: OutboundMessage): Promise<SendOutcome> {
  if (!twilioIsLive()) return { status: "simulated" };
  const sid = process.env.TWILIO_ACCOUNT_SID ?? "";
  const token = process.env.TWILIO_AUTH_TOKEN ?? "";
  const from =
    msg.channel === "whatsapp"
      ? (process.env.TWILIO_WHATSAPP_FROM ?? process.env.TWILIO_FROM_NUMBER ?? "")
      : (process.env.TWILIO_FROM_NUMBER ?? "");
  const prefix = msg.channel === "whatsapp" ? "whatsapp:" : "";
  const strip = (n: string) => n.replace(/^whatsapp:/, "");
  const form = new URLSearchParams({
    From: `${prefix}${strip(from)}`,
    To: `${prefix}${strip(msg.recipient)}`,
    Body: [msg.subject, msg.body].filter(Boolean).join("\n\n"),
  });
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form.toString(),
    signal: AbortSignal.timeout(15_000),
  });
  const data = (await res.json().catch(() => ({}))) as { sid?: string; message?: string };
  if (!res.ok) throw new Error(data.message ?? `Twilio returned ${res.status}`);
  return { status: "sent", providerId: data.sid };
}

async function sendInApp(): Promise<SendOutcome> {
  // In-app rows are the notification: the bell reads them straight from the outbox.
  return { status: "sent" };
}

async function sendWebhook(msg: OutboundMessage): Promise<SendOutcome> {
  let url: URL;
  try {
    url = new URL(msg.recipient);
  } catch {
    throw new Error("webhook recipient is not a valid URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("webhook must be http(s)");
  const refusal = await outboundUrlRefusal(url.toString());
  if (refusal) throw new Error(`webhook refused: ${refusal}`);
  const res = await fetch(url.toString(), {
    redirect: "error",
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "notification-outbox/1.0" },
    body: JSON.stringify({ subject: msg.subject, body: msg.body, data: msg.data ?? {}, sentAt: new Date().toISOString() }),
    signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`webhook returned ${res.status}`);
  return { status: "sent" };
}

async function sendPush(msg: OutboundMessage): Promise<SendOutcome> {
  const { isPushConfigured, deliverPushForUser } = await import("@/lib/push/sink");
  if (!isPushConfigured()) return { status: "simulated" };
  const r = await deliverPushForUser(msg.recipient, {
    title: msg.subject ?? "KernelHub",
    body: msg.body ?? "",
    url: typeof msg.data?.url === "string" ? msg.data.url : "/",
    tag: typeof msg.data?.tag === "string" ? msg.data.tag : null,
  });
  if (r.sent === 0 && r.failed > 0) throw new Error(`push failed on ${r.failed} device(s)`);
  return { status: r.sent > 0 ? "sent" : "simulated" };
}

const SENDERS: Record<NotificationChannel, Sender> = {
  email: sendEmail,
  sms: sendTwilio,
  whatsapp: sendTwilio,
  in_app: sendInApp,
  webhook: sendWebhook,
  push: sendPush,
};

export async function dispatch(msg: OutboundMessage): Promise<SendOutcome> {
  const sender = SENDERS[msg.channel];
  if (!sender) throw new Error(`unknown channel ${msg.channel}`);
  return sender(msg);
}
