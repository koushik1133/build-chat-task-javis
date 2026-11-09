import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { query, queryOne } from "@/lib/dsql";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { parseConversation, saveConversation, type ConversationTurn } from "@/lib/twilio-webhook";
import type { InboundChannel } from "@/lib/receptionist/inbound-agent";
import { sendMailReply } from "@/lib/mail/send";
import { takeOverByConversation } from "@/lib/webchat/service";
import { loadTwilioCreds, sendViaTwilio, twilioConfigured, type TwilioCreds } from "@/lib/messaging/twilio";

export async function GET() {
  let scope;
  try {
    scope = await requireScope({ area: "messaging", edit: false });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    const conversations = await query(
      `SELECT c.id, c.channel, c.from_number, c.messages, c.updated_at,
              s.id AS session_id, s.status AS session_status, s.page_url
       FROM messaging_conversations c
       LEFT JOIN chat_sessions s ON s.conversation_id = c.id AND s.user_id = c.user_id
       WHERE c.user_id = $1
       ORDER BY c.updated_at DESC`,
      [scope.dataId]
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

/** Append a human-authored reply to a thread and send it when Twilio is configured. */
export async function POST(req: NextRequest) {
  let scope;
  try {
    scope = await requireScope({ area: "messaging", edit: true });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const parsed = postSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid body" }, { status: 400 });
  }

  try {
    const conv = await queryOne<{ id: string; channel: InboundChannel; from_number: string; messages: string }>(
      `SELECT id, channel, from_number, messages FROM messaging_conversations WHERE id = $1 AND user_id = $2`,
      [parsed.data.conversationId, scope.dataId]
    );
    if (!conv) return NextResponse.json({ error: "Conversation not found" }, { status: 404 });

    const creds: TwilioCreds | null = await loadTwilioCreds(scope.dataId);

    const isWebchat = conv.channel === "webchat";
    const canSend = conv.channel !== "voice" && conv.channel !== "email" && !isWebchat && twilioConfigured(creds);

    let simulated = !canSend && !isWebchat;
    let sendError: string | null = null;
    if (isWebchat) {
      // Web chat replies are delivered on the visitor's next poll; a human reply ends the AI's turn.
      await takeOverByConversation(scope.dataId, conv.id).catch(() => null);
    } else if (conv.channel === "email") {
      // Email threads go back out through the mailbox that received them.
      try {
        const sent = await sendMailReply(scope.dataId, conv.id, parsed.data.text);
        simulated = sent.simulated;
      } catch (err) {
        simulated = true;
        sendError = err instanceof Error ? err.message : "Email send failed";
        console.error("[messaging] email send failed:", sendError);
      }
    } else if (canSend && creds) {
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
    const saved = await saveConversation(scope.dataId, conv.from_number, conv.channel, conv.id, messages);

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
