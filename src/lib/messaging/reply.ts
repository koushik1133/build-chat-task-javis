import { emitEvent } from "@/lib/events/bus";
import { sendMailReply } from "@/lib/mail/send";
import type { InboundChannel } from "@/lib/receptionist/inbound-agent";
import { loadConversation, saveConversation } from "@/lib/twilio-webhook";
import { discardDraft, releaseDraft } from "./reply-turns";
import { loadTwilioCreds, sendViaTwilio, twilioConfigured } from "./twilio";

/**
 * Deliver (or discard) a receptionist draft once an operator decides the
 * `messaging.reply` approval. The draft lives as a hidden `pending` turn in
 * `messaging_conversations` (from_number = `to`, channel); approving flips it
 * visible and sends it through the channel:
 *
 *   sms / whatsapp → Twilio when configured, otherwise recorded as simulated
 *   email          → the mail provider (sendMailReply), simulated when no account
 *   webchat        → visible turn is the delivery (visitor polls / SSE picks it up)
 */

export interface ReplyTarget {
  to: string;
  channel: InboundChannel;
  text: string;
}

export interface DeliverResult {
  conversationId: string;
  /** True when the message reached a real provider. */
  sent: boolean;
  simulated: boolean;
  /** True when a hidden draft turn was released (vs a new turn appended). */
  released: boolean;
  error: string | null;
}

export async function deliverApprovedReply(dataId: string, target: ReplyTarget): Promise<DeliverResult> {
  const text = target.text.trim().slice(0, 1600);
  if (!text) throw new Error("Reply text is empty");
  if (target.channel === "voice") throw new Error("Voice replies cannot be sent as text");
  const conv = await loadConversation(dataId, target.to, target.channel);

  let sent = false;
  let simulated = false;
  let error: string | null = null;
  if (target.channel === "webchat") {
    sent = true;
  } else if (target.channel === "email") {
    if (!conv.id) {
      simulated = true;
      error = "No email thread to reply to";
    } else {
      try {
        const r = await sendMailReply(dataId, conv.id, text);
        simulated = r.simulated;
        sent = !r.simulated;
      } catch (err) {
        simulated = true;
        error = err instanceof Error ? err.message : "Email send failed";
      }
    }
  } else {
    const creds = await loadTwilioCreds(dataId);
    if (twilioConfigured(creds)) {
      try {
        await sendViaTwilio(creds, target.channel, target.to, text);
        sent = true;
      } catch (err) {
        simulated = true;
        error = err instanceof Error ? err.message : "Twilio send failed";
      }
    } else {
      simulated = true;
    }
  }

  const { turns, released } = releaseDraft(conv.messages, text, { simulated });
  const saved = await saveConversation(dataId, target.to, target.channel, conv.id, turns);
  void emitEvent(dataId, { type: "message.sent", entity: "messaging_conversation", entityId: saved.id, data: { channel: target.channel, to: target.to, simulated, approved: true } });
  return { conversationId: saved.id, sent, simulated, released, error };
}

/** Rejecting the approval removes the hidden draft so it can never leak later. */
export async function discardPendingReply(dataId: string, target: Pick<ReplyTarget, "to" | "channel">): Promise<{ discarded: boolean }> {
  const conv = await loadConversation(dataId, target.to, target.channel);
  if (!conv.id) return { discarded: false };
  const { turns, discarded } = discardDraft(conv.messages);
  if (discarded) await saveConversation(dataId, target.to, target.channel, conv.id, turns);
  return { discarded };
}
