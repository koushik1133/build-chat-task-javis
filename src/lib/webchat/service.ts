import { randomUUID } from "crypto";
import { query, queryOne } from "@/lib/dsql";
import { emitEvent } from "@/lib/events/bus";
import { handleInboundMessage } from "@/lib/receptionist/inbound-agent";
import { parseConversation, saveConversation, type ConversationTurn } from "@/lib/twilio-webhook";
import { recordConsent } from "@/lib/privacy/consent";
import { MAX_VISITOR_MESSAGE, type VisitorMessage } from "./config";
import { getSessionByConversation, setSessionStatus, touchSession, type ChatSessionRow } from "./session";

/**
 * Web chat conversation service. Messages live in messaging_conversations
 * (channel "webchat", from_number "web:<sessionId>") so the staff inbox,
 * approvals and playbooks see them like any other channel.
 */

export const HUMAN_WILL_REPLY = "Thanks — a member of our team will reply here shortly.";

export function conversationAddress(sessionId: string): string {
  return `web:${sessionId}`;
}

/** Turns a visitor may see: drop receptionist drafts still awaiting approval. */
export function visibleMessages(turns: ConversationTurn[], since?: string | null): VisitorMessage[] {
  const sinceMs = since ? Date.parse(since) : NaN;
  return turns
    .filter((t) => (t.role === "user" || t.role === "assistant") && !t.pending)
    .filter((t) => !Number.isFinite(sinceMs) || Date.parse(t.ts) > sinceMs)
    .map((t) => ({ role: t.role, content: t.content, ts: t.ts }));
}

async function loadTurns(session: ChatSessionRow): Promise<{ conversationId: string | null; turns: ConversationTurn[] }> {
  if (!session.conversation_id) return { conversationId: null, turns: [] };
  const row = await queryOne<{ messages: string | null }>(`SELECT messages FROM messaging_conversations WHERE id = $1 AND user_id = $2`, [session.conversation_id, session.user_id]);
  return { conversationId: row ? session.conversation_id : null, turns: parseConversation(row?.messages) };
}

async function persist(session: ChatSessionRow, conversationId: string | null, turns: ConversationTurn[]): Promise<string> {
  const saved = await saveConversation(session.user_id, conversationAddress(session.id), "webchat", conversationId, turns);
  if (!conversationId && saved.id) {
    await query(`UPDATE chat_sessions SET conversation_id = $2, last_seen_at = NOW() WHERE id = $1`, [session.id, saved.id]);
  } else {
    await touchSession(session.id);
  }
  return saved.id;
}

export interface VisitorPostResult {
  /** Reply shown immediately (auto-send), or null when a human must answer. */
  reply: VisitorMessage | null;
  pendingHuman: boolean;
  messages: VisitorMessage[];
}

/** Append a visitor message, ask the receptionist (unless handed off), persist. */
export async function postVisitorMessage(session: ChatSessionRow, text: string): Promise<VisitorPostResult> {
  const clean = text.trim().slice(0, MAX_VISITOR_MESSAGE);
  const { conversationId, turns } = await loadTurns(session);
  const history = turns
    .filter((m) => (m.role === "user" || m.role === "assistant") && !m.pending)
    .slice(-20)
    .map((m) => ({ role: m.role, content: m.content }));

  const now = new Date().toISOString();
  turns.push({ role: "user", content: clean, ts: now });

  if (session.status === "handed_off") {
    await persist(session, conversationId, turns);
    void emitEvent(session.user_id, { type: "message.received", entity: "messaging_conversation", entityId: conversationAddress(session.id), data: { channel: "webchat", handedOff: true } });
    return { reply: null, pendingHuman: true, messages: visibleMessages(turns) };
  }

  const result = await handleInboundMessage(session.user_id, { channel: "webchat", fromNumber: conversationAddress(session.id), text: clean, history });
  const assistant: ConversationTurn = { role: "assistant", content: result.reply, ts: new Date(Date.now() + 1).toISOString(), intent: result.intent };
  if (!result.autoSend) assistant.pending = true;
  turns.push(assistant);
  await persist(session, conversationId, turns);

  return {
    reply: result.autoSend ? { role: "assistant", content: assistant.content, ts: assistant.ts } : null,
    pendingHuman: !result.autoSend,
    messages: visibleMessages(turns),
  };
}

export async function pollMessages(session: ChatSessionRow, since?: string | null): Promise<{ messages: VisitorMessage[]; status: ChatSessionRow["status"] }> {
  const { turns } = await loadTurns(session);
  const fresh = await queryOne<{ status: ChatSessionRow["status"] }>(`SELECT status FROM chat_sessions WHERE id = $1`, [session.id]);
  return { messages: visibleMessages(turns, since), status: fresh?.status ?? session.status };
}

export interface HandoffInput {
  name: string;
  email?: string | null;
  phone?: string | null;
  message?: string | null;
  consent?: { marketing: boolean } | null;
  evidence?: { ip?: string | null; ua?: string | null };
}

export interface HandoffResult {
  contactId: string;
  leadId: string;
  messages: VisitorMessage[];
}

/** Visitor leaves their details: link/create a contact + site lead, mark handed off. */
export async function requestHandoff(session: ChatSessionRow, input: HandoffInput): Promise<HandoffResult> {
  const email = input.email?.trim().toLowerCase() || null;
  const phone = input.phone?.trim() || null;
  const name = input.name.trim().slice(0, 120);

  let contactId: string | null = session.contact_id;
  if (!contactId && email) {
    const existing = await queryOne<{ id: string }>(`SELECT id FROM crm_contacts WHERE user_id = $1 AND LOWER(email) = $2 LIMIT 1`, [session.user_id, email]).catch(() => null);
    contactId = existing?.id ?? null;
  }
  if (!contactId) {
    const created = await queryOne<{ id: string }>(
      `INSERT INTO crm_contacts (id, user_id, full_name, email, phone, lifecycle, tags, notes, created_at)
       VALUES ($1, $2, $3, $4, $5, 'lead', '["webchat"]', $6, NOW()) RETURNING id`,
      [randomUUID(), session.user_id, name || "Website visitor", email, phone, `Started from web chat${session.page_url ? ` on ${session.page_url}` : ""}`]
    );
    contactId = created?.id ?? null;
    if (contactId) void emitEvent(session.user_id, { type: "crm.contact.created", entity: "crm_contact", entityId: contactId, data: { source: "webchat" } });
  }
  if (!contactId) throw new Error("could not create contact");

  const { turns } = await loadTurns(session);
  const transcript = turns.filter((t) => !t.pending).slice(-10).map((t) => `${t.role === "user" ? "Visitor" : "Assistant"}: ${t.content}`).join("\n");
  const leadId = randomUUID();
  await query(
    `INSERT INTO site_leads (id, site_id, user_id, data, status, created_at) VALUES ($1, $2, $3, $4, 'new', NOW())`,
    [leadId, session.site_id, session.user_id, JSON.stringify({ name, email, phone, message: input.message?.trim().slice(0, 2000) || null, source: "webchat", page_url: session.page_url, transcript: transcript.slice(0, 4000) })]
  );
  void emitEvent(session.user_id, { type: "lead.captured", entity: "site_lead", entityId: leadId, data: { siteId: session.site_id, source: "webchat" } });

  if (input.consent && typeof input.consent.marketing === "boolean") {
    const evidence = { ip: input.evidence?.ip ?? null, ua: input.evidence?.ua ?? null, text_version: `site:${session.site_id}` };
    const status = input.consent.marketing ? "granted" : "withdrawn";
    for (const purpose of ["marketing_email", "marketing_sms"] as const) {
      void recordConsent(session.user_id, { kind: "contact", id: contactId }, purpose, status, "form", evidence).catch(() => undefined);
      void recordConsent(session.user_id, { kind: "lead", id: leadId }, purpose, status, "form", evidence).catch(() => undefined);
    }
  }

  await query(
    `UPDATE chat_sessions SET contact_id = $2, lead_id = $3, status = 'handed_off', last_seen_at = NOW() WHERE id = $1`,
    [session.id, contactId, leadId]
  );
  turns.push({ role: "assistant", content: `Thanks${name ? `, ${name.split(" ")[0]}` : ""}! ${HUMAN_WILL_REPLY}`, ts: new Date().toISOString() });
  await persist(session, session.conversation_id, turns);

  void emitEvent(session.user_id, { type: "webchat.handoff_requested", entity: "chat_session", entityId: session.id, data: { contactId, leadId, siteId: session.site_id } });
  return { contactId, leadId, messages: visibleMessages(turns) };
}

/** Staff takes over: auto replies stop for this session. */
export async function takeOverByConversation(dataId: string, conversationId: string): Promise<ChatSessionRow | null> {
  const session = await getSessionByConversation(dataId, conversationId);
  if (!session) return null;
  if (session.status === "open") await setSessionStatus(session.id, "handed_off");
  return { ...session, status: session.status === "open" ? "handed_off" : session.status };
}

/** Count of open sessions whose last visible message is from the visitor. */
export async function unansweredCount(dataId: string): Promise<{ open: number; unanswered: number }> {
  const rows = await query<{ id: string; messages: string | null }>(
    `SELECT s.id, c.messages FROM chat_sessions s LEFT JOIN messaging_conversations c ON c.id = s.conversation_id
     WHERE s.user_id = $1 AND s.status IN ('open','handed_off') AND s.expires_at > NOW()`,
    [dataId]
  );
  let unanswered = 0;
  for (const r of rows) {
    const visible = visibleMessages(parseConversation(r.messages));
    if (visible.length && visible[visible.length - 1].role === "user") unanswered++;
  }
  return { open: rows.length, unanswered };
}
