import { NextRequest, NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "crypto";
import { queryOne, query } from "@/lib/dsql";
import { complete } from "@/lib/llm";

/** Max stored turns kept per conversation, so LLM context can't grow without bound. */
const MAX_HISTORY = 40;

interface ConversationTurn {
  role: "user" | "assistant";
  content: string;
  ts: string;
}

function twiml(message?: string) {
  const body = message
    ? `<Message>${message
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")}</Message>`
    : "";
  return new NextResponse(
    `<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`,
    { status: 200, headers: { "Content-Type": "text/xml" } }
  );
}

/**
 * Twilio signs `url + <sorted key+value pairs>` with the account auth token
 * (HMAC-SHA1, base64). Behind a proxy the request URL Next.js sees may differ
 * from the one Twilio signed, so every plausible public URL is checked.
 */
function candidateUrls(req: NextRequest): string[] {
  const urls = new Set<string>([req.url]);
  const path = new URL(req.url).pathname;

  const configured = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "");
  if (configured) urls.add(`${configured}${path}`);

  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  const proto = req.headers.get("x-forwarded-proto") ?? "https";
  if (host) urls.add(`${proto}://${host}${path}`);

  return [...urls];
}

/** Exported for unit tests: compute Twilio's expected signature for a URL + params. */
export function twilioSignature(url: string, params: URLSearchParams, authToken: string): string {
  let data = url;
  for (const key of [...params.keys()].sort()) {
    data += key + params.getAll(key).join("");
  }
  return createHmac("sha1", authToken).update(Buffer.from(data, "utf8")).digest("base64");
}

function signatureMatches(
  url: string,
  params: URLSearchParams,
  authToken: string,
  provided: string
): boolean {
  const a = Buffer.from(twilioSignature(url, params, authToken));
  const b = Buffer.from(provided);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function verifyTwilioSignature(
  req: NextRequest,
  params: URLSearchParams,
  authToken: string
): boolean {
  const provided = req.headers.get("x-twilio-signature");
  if (!provided) return false;
  return candidateUrls(req).some((url) =>
    signatureMatches(url, params, authToken, provided)
  );
}

/**
 * Shared inbound handler for the Twilio SMS and WhatsApp webhooks.
 *
 * Requests are rejected unless they carry a valid `X-Twilio-Signature` for the
 * auth token of the account that owns the destination number — otherwise
 * anyone could forge inbound messages, poison a tenant's conversation history
 * and drive LLM spend.
 */
export async function handleTwilioInbound(req: NextRequest) {
  try {
    const raw = await req.text();
    const params = new URLSearchParams(raw);
    const fromRaw = params.get("From") ?? "";
    const toRaw = params.get("To") ?? "";
    const bodyText = params.get("Body") ?? "";

    if (!fromRaw || !toRaw || !bodyText) return twiml();

    const isWhatsApp = fromRaw.startsWith("whatsapp:");
    const fromNumber = fromRaw.replace(/^whatsapp:/, "");
    const toNumber = toRaw.replace(/^whatsapp:/, "");
    const channel = isWhatsApp ? "whatsapp" : "sms";

    const integration = await queryOne<{
      user_id: string;
      messaging_auto_reply: boolean;
      twilio_auth_token: string | null;
    }>(
      `SELECT user_id, messaging_auto_reply, twilio_auth_token
       FROM user_integrations WHERE twilio_from_number = $1`,
      [toNumber]
    );

    // Unknown destination number: say nothing rather than confirming to an
    // unauthenticated caller whether a number is provisioned.
    if (!integration) return twiml();

    const skipVerification =
      process.env.TWILIO_SKIP_SIGNATURE_VERIFICATION === "true";

    if (!skipVerification) {
      const authToken =
        integration.twilio_auth_token || process.env.TWILIO_AUTH_TOKEN || "";
      if (!authToken || !verifyTwilioSignature(req, params, authToken)) {
        console.warn(`[twilio] rejected unverified ${channel} webhook for ${toNumber}`);
        return new NextResponse("Forbidden", { status: 403 });
      }
    }

    const conv = await queryOne<{ id: string; messages: string }>(
      `SELECT id, messages FROM messaging_conversations
       WHERE user_id = $1 AND from_number = $2 AND channel = $3`,
      [integration.user_id, fromNumber, channel]
    );

    let messages: ConversationTurn[] = [];
    if (conv?.messages) {
      try {
        const parsed = JSON.parse(conv.messages);
        if (Array.isArray(parsed)) messages = parsed;
      } catch {
        // Corrupt history — start a fresh thread rather than failing the reply.
      }
    }

    messages.push({ role: "user", content: bodyText, ts: new Date().toISOString() });

    let replyText = "Message received, but AI auto-reply is disabled.";
    if (integration.messaging_auto_reply) {
      const chatMessages = [
        {
          role: "system" as const,
          content:
            "You are a helpful business assistant for KernelHub. Keep your answers concise, friendly, and suitable for a text message.",
        },
        ...messages
          .filter((m) => m.role === "user" || m.role === "assistant")
          .slice(-MAX_HISTORY)
          .map((m) => ({ role: m.role, content: m.content })),
      ];
      try {
        replyText = await complete(chatMessages);
      } catch (err) {
        console.error("[twilio] auto-reply generation failed:", err);
        replyText = "Sorry — I couldn't process that just now. Please try again shortly.";
      }
    }

    messages.push({ role: "assistant", content: replyText, ts: new Date().toISOString() });
    const trimmed = messages.slice(-MAX_HISTORY);

    if (conv?.id) {
      await query(
        `UPDATE messaging_conversations SET messages = $1, updated_at = NOW() WHERE id = $2`,
        [JSON.stringify(trimmed), conv.id]
      );
    } else {
      await queryOne(
        `INSERT INTO messaging_conversations (user_id, channel, from_number, messages, created_at, updated_at)
         VALUES ($1, $2, $3, $4, NOW(), NOW()) RETURNING id`,
        [integration.user_id, channel, fromNumber, JSON.stringify(trimmed)]
      );
    }

    return twiml(replyText);
  } catch (err) {
    console.error("Twilio webhook error:", err);
    return twiml();
  }
}
