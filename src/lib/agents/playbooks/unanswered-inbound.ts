import { query, queryOne } from "@/lib/dsql";
import type { PlaybookDef } from "./types";

type Msg = { role: string; content: string; ts?: string; pending?: boolean };
type Convo = { id: string; channel: string; from_number: string; messages: string | null; updated_at: string };

function parse(raw: string | null): Msg[] {
  try {
    const v: unknown = JSON.parse(raw ?? "[]");
    return Array.isArray(v) ? (v as Msg[]) : [];
  } catch {
    return [];
  }
}

const TWO_HOURS = 2 * 60 * 60 * 1000;

/**
 * messaging_conversations whose last message came from the customer > 2h ago.
 * `messages` is a JSON TEXT column ([{role, content, ts}]), so the "last
 * message" check happens in code; SQL only pre-filters on updated_at.
 */
export const unansweredInbound: PlaybookDef = {
  id: "unanswered-inbound",
  name: "Unanswered inbound message",
  description: "Flags WhatsApp, SMS and website chat conversations where the customer wrote last and nobody replied for 2+ hours.",
  eventTypes: ["message.received"],
  cooldownHours: 6,
  defaultTools: ["comms.draft_email", "comms.notify"],
  async detect(userId) {
    const rows = await query<Convo>(
      `SELECT id, channel, from_number, messages, updated_at FROM messaging_conversations
       WHERE user_id = $1 AND updated_at < NOW() - INTERVAL '2 hours'
       ORDER BY updated_at DESC LIMIT 100`,
      [userId]
    ).catch(() => []);
    const cutoff = Date.now() - TWO_HOURS;
    return rows
      .filter((r) => {
        // Web chat: a receptionist draft still awaiting approval is invisible to the visitor, so it does not count as a reply.
        const msgs = r.channel === "webchat" ? parse(r.messages).filter((m) => !m.pending) : parse(r.messages);
        const last = msgs[msgs.length - 1];
        if (!last || last.role !== "user") return false;
        const at = last.ts ? Date.parse(last.ts) : Date.parse(r.updated_at);
        return Number.isFinite(at) ? at < cutoff : true;
      })
      .map((r) => r.id);
  },
  async buildPrompt(userId, entityId) {
    const c = await queryOne<Convo>(
      `SELECT id, channel, from_number, messages, updated_at FROM messaging_conversations WHERE id = $1 AND user_id = $2`,
      [entityId, userId]
    ).catch(() => null);
    if (!c) return `Conversation ${entityId} no longer exists; do nothing and finish.`;
    const recent = parse(c.messages).slice(-6)
      .map((m) => `[${m.role}${m.ts ? ` ${m.ts}` : ""}] ${m.content.slice(0, 400)}`)
      .join("\n");
    return [
      `An inbound ${c.channel} conversation from ${c.from_number} (id ${c.id}) has gone unanswered for over 2 hours.`,
      "Recent messages:",
      recent || "(none)",
      "",
      "1. Draft a reply that answers the customer's last message using comms.draft_email (channel reply text goes in the body).",
      "2. Notify the owner with comms.notify that this conversation needs attention, including a one-line summary.",
    ].join("\n");
  },
};
