import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { query, queryOne } from "@/lib/dsql";
import { requireUser } from "@/lib/supabase/server";
import { decryptSecret } from "@/lib/secure-store";
import { parseConversation, saveConversation, type ConversationTurn } from "@/lib/twilio-webhook";
import type { InboundChannel } from "@/lib/receptionist/inbound-agent";

export async function GET() {
  let user;
  try {
    ({ user } = await requireUser());
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    const conversations = await query(
      `SELECT id, channel, from_number, messages, updated_at
       FROM messaging_conversations
       WHERE user_id = $1
       ORDER BY updated_at DESC`,
      [user.id]
    );
    return NextResponse.json({ conversations }, { status: 200 });
  } catch (err) {
    console.error("Get Messaging Conversations Error:", err);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

const postSchema = z.object({
  conversationId: z.string().min(1).max(100),
  text: z.string().trim().min(1).max(1600),
});

interface TwilioCreds {
  twilio_sid: string | null;
  twilio_auth_token: string | null;
  twilio_from_number: string | null;
}

function plain(v: string | null): string {
  return v ? decryptSecret(v) ?? v : "";
}

/** Send via Twilio's REST API with fetch (no SDK). Returns the message SID. */
async function sendViaTwilio(creds: TwilioCreds, channel: InboundChannel, to: string, body: string): Promise<string> {
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

/** Append a human-authored reply to a thread and send it when Twilio is configured. */
export async function POST(req: NextRequest) {
  let user;
  try {
    ({ user } = await requireUser());
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const parsed = postSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid body" }, { status: 400 });
  }

  try {
    const conv = await queryOne<{ id: string; channel: InboundChannel; from_number: string; messages: string }>(
      `SELECT id, channel, from_number, messages FROM messaging_conversations WHERE id = $1 AND user_id = $2`,
      [parsed.data.conversationId, user.id]
    );
    if (!conv) return NextResponse.json({ error: "Conversation not found" }, { status: 404 });

    const creds = await queryOne<TwilioCreds>(
      `SELECT twilio_sid, twilio_auth_token, twilio_from_number FROM user_integrations WHERE user_id = $1`,
      [user.id]
    ).catch(() => null);

    const canSend =
      conv.channel !== "voice" &&
      !!creds?.twilio_sid && !!creds?.twilio_auth_token && !!creds?.twilio_from_number;

    let simulated = !canSend;
    let sendError: string | null = null;
    if (canSend && creds) {
      try {
        await sendViaTwilio(creds, conv.channel, conv.from_number, parsed.data.text);
      } catch (err) {
        simulated = true;
        sendError = err instanceof Error ? err.message : "Twilio send failed";
        console.error("[messaging] Twilio send failed:", sendError);
      }
    }

    const turn: ConversationTurn = { role: "assistant", content: parsed.data.text, ts: new Date().toISOString() };
    if (simulated) turn.simulated = true;

    const messages = parseConversation(conv.messages);
    messages.push(turn);
    const saved = await saveConversation(user.id, conv.from_number, conv.channel, conv.id, messages);

    return NextResponse.json({
      ok: true,
      simulated,
      error: sendError,
      conversation: {
        id: saved.id,
        channel: conv.channel,
        from_number: conv.from_number,
        messages: JSON.stringify(saved.messages),
        updated_at: new Date().toISOString(),
      },
    });
  } catch (err) {
    console.error("[messaging] reply failed:", err);
    return NextResponse.json({ error: "Could not send that reply." }, { status: 500 });
  }
}
