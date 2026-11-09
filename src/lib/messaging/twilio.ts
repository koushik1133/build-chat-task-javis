import { queryOne } from "@/lib/dsql";
import { decryptSecret } from "@/lib/secure-store";
import type { InboundChannel } from "@/lib/receptionist/inbound-agent";

/** Outbound SMS / WhatsApp through Twilio's REST API (fetch, no SDK). */

export interface TwilioCreds {
  twilio_sid: string | null;
  twilio_auth_token: string | null;
  twilio_from_number: string | null;
}

function plain(v: string | null): string {
  return v ? (decryptSecret(v) ?? v) : "";
}

export async function loadTwilioCreds(dataId: string): Promise<TwilioCreds | null> {
  return queryOne<TwilioCreds>(`SELECT twilio_sid, twilio_auth_token, twilio_from_number FROM user_integrations WHERE user_id = $1`, [dataId]).catch(() => null);
}

export function twilioConfigured(creds: TwilioCreds | null): creds is TwilioCreds {
  return Boolean(creds?.twilio_sid && creds?.twilio_auth_token && creds?.twilio_from_number);
}

/** Send one message. Returns the message SID. */
export async function sendViaTwilio(creds: TwilioCreds, channel: InboundChannel, to: string, body: string): Promise<string> {
  const sid = plain(creds.twilio_sid);
  const token = plain(creds.twilio_auth_token);
  const from = creds.twilio_from_number ?? "";
  const prefix = channel === "whatsapp" ? "whatsapp:" : "";
  const form = new URLSearchParams({ From: `${prefix}${from}`, To: `${prefix}${to}`, Body: body });

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
  return data.sid ?? "";
}
