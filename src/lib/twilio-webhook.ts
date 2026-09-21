import { NextRequest, NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "crypto";
import { queryOne, query } from "@/lib/dsql";
import { decryptSecret } from "@/lib/secure-store";
import { handleInboundMessage, type InboundChannel, type InboundResult } from "@/lib/receptionist/inbound-agent";

/** Max stored turns kept per conversation, so LLM context can't grow without bound. */
const MAX_HISTORY = 40;

/** Sent back over the channel when a drafted reply is held for human approval. */
export const HOLD_ACK = "Thanks — a team member will reply shortly.";

export interface ConversationTurn {
  role: "user" | "assistant";
  content: string;
  ts: string;
  /** Drafted by the receptionist but not sent; awaiting approval in the inbox. */
  pending?: boolean;
  /** Sent from the UI without Twilio credentials (demo mode). */
  simulated?: boolean;
  /** Intent the receptionist classified for the turn it replied to. */
  intent?: string;
}

/** Pure TwiML builder for the messaging webhooks (exported for tests). */
export function buildTwiml(message?: string): string {
  const body = message
    ? `<Message>${message
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")}</Message>`
    : "";
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`;
}

function twiml(message?: string) {
  return new NextResponse(buildTwiml(message), {
    status: 200,
    headers: { "Content-Type": "text/xml" },
  });
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

// ── Shared tenant lookup + persistence (used by SMS/WhatsApp, voice, simulator) ──

export interface TwilioIntegration {
  user_id: string;
  messaging_auto_reply: boolean;
  twilio_auth_token: string | null;
}

/** Find the tenant that owns a Twilio number. Null when unprovisioned. */
export async function findIntegrationByNumber(toNumber: string): Promise<TwilioIntegration | null> {
  return queryOne<TwilioIntegration>(
    `SELECT user_id, messaging_auto_reply, twilio_auth_token
     FROM user_integrations WHERE twilio_from_number = $1`,
    [toNumber]
  );
}

/** Auth token may be stored encrypted (v1:…) or plain; env var is the fallback. */
export function resolveAuthToken(integration: TwilioIntegration): string {
  const stored = integration.twilio_auth_token;
  return (stored ? decryptSecret(stored) ?? stored : "") || process.env.TWILIO_AUTH_TOKEN || "";
}

/**
 * Verify a Twilio-signed request for the tenant that owns `toNumber`.
 * Returns the integration, or a NextResponse to send back (403, or the
 * caller's "unknown number" response so we never confirm which numbers exist).
 */
export async function authorizeTwilioRequest(
  req: NextRequest,
  params: URLSearchParams,
  toNumber: string,
  unknownNumber: () => NextResponse
): Promise<TwilioIntegration | NextResponse> {
  const integration = await findIntegrationByNumber(toNumber);
  if (!integration) return unknownNumber();

  const skipVerification = process.env.TWILIO_SKIP_SIGNATURE_VERIFICATION === "true";
  if (!skipVerification) {
    const authToken = resolveAuthToken(integration);
    if (!authToken || !verifyTwilioSignature(req, params, authToken)) {
      console.warn(`[twilio] rejected unverified webhook for ${toNumber}`);
      return new NextResponse("Forbidden", { status: 403 });
    }
  }
  return integration;
}

export function parseConversation(raw: string | null | undefined): ConversationTurn[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ConversationTurn[]) : [];
  } catch {
    // Corrupt history — start a fresh thread rather than failing the reply.
    return [];
  }
}

export async function loadConversation(userId: string, fromNumber: string, channel: InboundChannel) {
  const conv = await queryOne<{ id: string; messages: string }>(
    `SELECT id, messages FROM messaging_conversations
     WHERE user_id = $1 AND from_number = $2 AND channel = $3`,
    [userId, fromNumber, channel]
  );
  return { id: conv?.id ?? null, messages: parseConversation(conv?.messages) };
}

/** Upsert the thread, keeping only the newest MAX_HISTORY turns. Returns the row id. */
export async function saveConversation(
  userId: string,
  fromNumber: string,
  channel: InboundChannel,
  conversationId: string | null,
  messages: ConversationTurn[]
): Promise<{ id: string; messages: ConversationTurn[] }> {
  const trimmed = messages.slice(-MAX_HISTORY);
  if (conversationId) {
    await query(
      `UPDATE messaging_conversations SET messages = $1, updated_at = NOW() WHERE id = $2`,
      [JSON.stringify(trimmed), conversationId]
    );
    return { id: conversationId, messages: trimmed };
  }
  const row = await queryOne<{ id: string }>(
    `INSERT INTO messaging_conversations (user_id, channel, from_number, messages, created_at, updated_at)
     VALUES ($1, $2, $3, $4, NOW(), NOW()) RETURNING id`,
    [userId, channel, fromNumber, JSON.stringify(trimmed)]
  );
  return { id: row?.id ?? "", messages: trimmed };
}

export interface ProcessedInbound {
  conversationId: string;
  messages: ConversationTurn[];
  result: InboundResult;
}

/**
 * The full inbound pipeline: append the user turn, ask the receptionist for a
 * reply, append it (flagged `pending` when it must be approved), persist.
 */
export async function processInbound(input: {
  userId: string;
  channel: InboundChannel;
  fromNumber: string;
  text: string;
}): Promise<ProcessedInbound> {
  const conv = await loadConversation(input.userId, input.fromNumber, input.channel);
  const history = conv.messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .slice(-MAX_HISTORY)
    .map((m) => ({ role: m.role, content: m.content }));

  const messages = [...conv.messages];
  messages.push({ role: "user", content: input.text, ts: new Date().toISOString() });

  const result = await handleInboundMessage(input.userId, {
    channel: input.channel,
    fromNumber: input.fromNumber,
    text: input.text,
    history,
  });

  const assistantTurn: ConversationTurn = {
    role: "assistant",
    content: result.reply,
    ts: new Date().toISOString(),
    intent: result.intent,
  };
  if (!result.autoSend) assistantTurn.pending = true;
  messages.push(assistantTurn);

  const saved = await saveConversation(input.userId, input.fromNumber, input.channel, conv.id, messages);
  return { conversationId: saved.id, messages: saved.messages, result };
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
    const channel: InboundChannel = isWhatsApp ? "whatsapp" : "sms";

    // Unknown destination number: say nothing rather than confirming to an
    // unauthenticated caller whether a number is provisioned.
    const auth = await authorizeTwilioRequest(req, params, toNumber, () => twiml());
    if (auth instanceof NextResponse) return auth;

    const { result } = await processInbound({
      userId: auth.user_id,
      channel,
      fromNumber,
      text: bodyText,
    });

    return twiml(result.autoSend ? result.reply : HOLD_ACK);
  } catch (err) {
    console.error("Twilio webhook error:", err);
    return twiml();
  }
}
