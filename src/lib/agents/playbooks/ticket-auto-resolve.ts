import { query, queryOne } from "@/lib/dsql";
import { formatTicketNumber, type TicketRow } from "@/lib/helpdesk/tickets";
import type { PlaybookDef } from "./types";

type Msg = { author_kind: string; body: string; created_at: string };

/**
 * Open tickets with no public reply yet (>= 10 minutes old, under their first
 * response SLA or not): the agent looks up the knowledge base and prepares a
 * reply. `helpdesk.reply` always pauses for approval, so nothing is sent
 * without a human unless the agent runs at autonomy "auto".
 */
export const ticketAutoResolve: PlaybookDef = {
  id: "ticket-auto-resolve",
  name: "Ticket auto-resolve",
  description: "Answers new support tickets from the knowledge base and drafts a first reply before the SLA clock runs out.",
  eventTypes: ["ticket.created"],
  cooldownHours: 24,
  defaultTools: ["helpdesk.get_ticket", "kb.search", "helpdesk.reply", "helpdesk.set_status"],
  async detect(userId) {
    const rows = await query<{ id: string }>(
      `SELECT id FROM tickets
       WHERE user_id = $1 AND status = 'open' AND first_responded_at IS NULL
         AND created_at < NOW() - INTERVAL '10 minutes'
       ORDER BY CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
                first_response_due_at ASC NULLS LAST, created_at ASC
       LIMIT 20`,
      [userId]
    ).catch(() => []);
    return rows.map((r) => r.id);
  },
  async buildPrompt(userId, entityId) {
    const t = await queryOne<TicketRow>(
      `SELECT id, number, subject, status, priority, source, requester_name, requester_email, first_response_due_at, resolution_due_at, created_at
       FROM tickets WHERE id = $1 AND user_id = $2`,
      [entityId, userId]
    ).catch(() => null);
    if (!t) return `Ticket ${entityId} no longer exists; do nothing and finish.`;
    const msgs = await query<Msg>(
      `SELECT author_kind, body, created_at FROM ticket_messages WHERE ticket_id = $1 AND user_id = $2 AND is_internal = FALSE ORDER BY created_at ASC LIMIT 10`,
      [t.id, userId]
    ).catch(() => []);
    const thread = msgs.map((m) => `[${m.author_kind} ${m.created_at}] ${m.body.slice(0, 600)}`).join("\n");
    return [
      `Support ticket ${formatTicketNumber(t.number)} (id ${t.id}) "${t.subject}" from ${t.requester_name ?? t.requester_email ?? "a customer"} is ${t.priority} priority, arrived via ${t.source} and has had no reply yet.`,
      t.first_response_due_at ? `First response is due ${t.first_response_due_at}.` : "",
      "Thread so far:",
      thread || "(no messages)",
      "",
      "1. Call helpdesk.get_ticket if you need more context.",
      "2. Search the knowledge base with kb.search for the customer's problem (try 2 phrasings if the first finds nothing).",
      "3. If an article clearly answers it, write a friendly, specific reply that walks through the fix and links/mentions the article title, then call helpdesk.reply (is_internal=false).",
      "4. If nothing in the knowledge base applies, call helpdesk.reply with is_internal=true summarising what you checked and what a human should look at. Do NOT guess at a public answer.",
      "5. Never change the status to resolved yourself; the human who approves the reply decides that.",
    ]
      .filter(Boolean)
      .join("\n");
  },
};
