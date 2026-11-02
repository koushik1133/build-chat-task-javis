import { z } from "zod";
import { registerTool } from "@/lib/agents/registry";
import type { ToolResult } from "@/lib/agents/types";
import { addMessage, formatTicketNumber, getTicket, listTickets, parseTags, setStatus, type TicketRow } from "@/lib/helpdesk/tickets";
import { TICKET_PRIORITIES, TICKET_STATUSES } from "@/lib/helpdesk/sla";
import { draftArticleFromTickets } from "@/lib/kb/articles";
import { searchArticles } from "@/lib/kb/search";
import { enqueueNotification } from "@/lib/notifications/outbox";

/** Helpdesk + knowledge-base tools for agents, copilots and MCP. */

function fail(error: string): ToolResult {
  return { ok: false, summary: error, error };
}
function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function summarise(t: TicketRow) {
  return {
    id: t.id,
    number: formatTicketNumber(t.number),
    subject: t.subject,
    status: t.status,
    priority: t.priority,
    source: t.source,
    requester_email: t.requester_email,
    requester_name: t.requester_name,
    first_response_due_at: t.first_response_due_at,
    resolution_due_at: t.resolution_due_at,
    first_responded_at: t.first_responded_at,
    breached: t.breached_first_response || t.breached_resolution,
    tags: parseTags(t.tags),
    created_at: t.created_at,
  };
}

/* ---------- helpdesk.list_tickets ---------- */
const ListInput = z.object({
  status: z.enum([...TICKET_STATUSES, "active", "all"]).optional(),
  q: z.string().max(200).optional(),
  priority: z.enum(TICKET_PRIORITIES).optional(),
  limit: z.number().int().min(1).max(50).optional(),
});
type ListInputT = z.infer<typeof ListInput>;

registerTool<ListInputT>({
  name: "helpdesk.list_tickets",
  module: "helpdesk",
  description: "List support tickets. Defaults to active (open + pending) tickets, most urgent first. Filter by status, priority or a search term.",
  input: ListInput,
  parameters: {
    type: "object",
    properties: {
      status: { type: "string", enum: [...TICKET_STATUSES, "active", "all"] },
      q: { type: "string" },
      priority: { type: "string", enum: [...TICKET_PRIORITIES] },
      limit: { type: "integer", minimum: 1, maximum: 50 },
    },
  },
  scope: "read",
  preview: (i) => `List ${i.status ?? "active"} tickets${i.q ? ` matching "${i.q}"` : ""}`,
  async run(ctx, input) {
    try {
      const rows = await listTickets(ctx.userId, { status: input.status ?? "active", q: input.q, priority: input.priority, limit: input.limit ?? 20 });
      return { ok: true, data: rows.map(summarise), summary: `${rows.length} ticket(s)` };
    } catch (err) {
      return fail(`Could not list tickets: ${errMsg(err)}`);
    }
  },
});

/* ---------- helpdesk.get_ticket ---------- */
const GetInput = z.object({ ticketId: z.string().min(1).max(100) });
type GetInputT = z.infer<typeof GetInput>;

registerTool<GetInputT>({
  name: "helpdesk.get_ticket",
  module: "helpdesk",
  description: "Read one ticket with its full message thread (customer, agent, AI and internal notes).",
  input: GetInput,
  parameters: { type: "object", properties: { ticketId: { type: "string" } }, required: ["ticketId"] },
  scope: "read",
  preview: (i) => `Read ticket ${i.ticketId.slice(0, 8)}`,
  async run(ctx, input) {
    try {
      const t = await getTicket(ctx.userId, input.ticketId);
      if (!t) return fail("Ticket not found");
      const messages = t.messages.map((m) => ({ author: m.author_kind, internal: m.is_internal, body: m.body.slice(0, 3000), at: m.created_at }));
      return { ok: true, data: { ...summarise(t), messages }, summary: `${formatTicketNumber(t.number)} ${t.subject} (${t.status}, ${messages.length} messages)` };
    } catch (err) {
      return fail(`Could not read ticket: ${errMsg(err)}`);
    }
  },
});

/* ---------- helpdesk.reply ---------- */
const ReplyInput = z.object({
  ticketId: z.string().min(1).max(100),
  body: z.string().min(1).max(20_000),
  is_internal: z.boolean().optional(),
});
type ReplyInputT = z.infer<typeof ReplyInput>;

registerTool<ReplyInputT>({
  name: "helpdesk.reply",
  module: "helpdesk",
  description: "Reply on a ticket. Public replies (is_internal=false) are emailed to the requester and count as the first response; internal notes are only visible to the team.",
  input: ReplyInput,
  parameters: {
    type: "object",
    properties: { ticketId: { type: "string" }, body: { type: "string" }, is_internal: { type: "boolean" } },
    required: ["ticketId", "body"],
  },
  scope: "write",
  requiresApproval: true,
  preview: (i) => `${i.is_internal ? "Internal note" : "Reply"} on ticket ${i.ticketId.slice(0, 8)}: "${i.body.slice(0, 80)}${i.body.length > 80 ? "…" : ""}"`,
  async run(ctx, input) {
    try {
      const { message, ticket } = await addMessage(ctx.userId, input.ticketId, {
        author_kind: "ai",
        author_id: ctx.agentId,
        body: input.body,
        is_internal: input.is_internal ?? false,
      });
      let emailed = false;
      if (!message.is_internal && ticket.requester_email) {
        await enqueueNotification(ctx.userId, {
          channel: "email",
          recipient: ticket.requester_email,
          subject: `Re: ${ticket.subject} [${formatTicketNumber(ticket.number)}]`,
          body: message.body,
          data: { ticketId: ticket.id, messageId: message.id, kind: "ticket.reply", by: "agent" },
        }).then(() => { emailed = true; }).catch((err) => console.error("[helpdesk.reply] email enqueue failed:", err));
      }
      return {
        ok: true,
        data: { messageId: message.id, ticket: summarise(ticket), emailed },
        summary: `${message.is_internal ? "Internal note added to" : "Replied on"} ${formatTicketNumber(ticket.number)}${emailed ? " (email queued)" : ""}`,
      };
    } catch (err) {
      return fail(`Reply failed: ${errMsg(err)}`);
    }
  },
});

/* ---------- helpdesk.set_status ---------- */
const StatusInput = z.object({ ticketId: z.string().min(1).max(100), status: z.enum(TICKET_STATUSES) });
type StatusInputT = z.infer<typeof StatusInput>;

registerTool<StatusInputT>({
  name: "helpdesk.set_status",
  module: "helpdesk",
  description: "Change a ticket's status (open, pending, resolved, closed). Resolving stamps resolved_at and emits ticket.resolved.",
  input: StatusInput,
  parameters: {
    type: "object",
    properties: { ticketId: { type: "string" }, status: { type: "string", enum: [...TICKET_STATUSES] } },
    required: ["ticketId", "status"],
  },
  scope: "write",
  preview: (i) => `Mark ticket ${i.ticketId.slice(0, 8)} as ${i.status}`,
  async run(ctx, input) {
    try {
      const t = await setStatus(ctx.userId, input.ticketId, input.status, { actorId: ctx.agentId });
      return { ok: true, data: summarise(t), summary: `${formatTicketNumber(t.number)} is now ${t.status}` };
    } catch (err) {
      return fail(`Status change failed: ${errMsg(err)}`);
    }
  },
});

/* ---------- kb.search ---------- */
const KbSearchInput = z.object({
  query: z.string().min(1).max(300),
  limit: z.number().int().min(1).max(10).optional(),
});
type KbSearchInputT = z.infer<typeof KbSearchInput>;

registerTool<KbSearchInputT>({
  name: "kb.search",
  module: "knowledge",
  description: "Search published knowledge-base articles (semantic when Pinecone is configured, keyword otherwise). Use it before answering a support question.",
  input: KbSearchInput,
  parameters: {
    type: "object",
    properties: { query: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 10 } },
    required: ["query"],
  },
  scope: "read",
  preview: (i) => `Search knowledge base for "${i.query.slice(0, 60)}"`,
  async run(ctx, input) {
    try {
      const hits = await searchArticles(ctx.userId, input.query, input.limit ?? 5);
      const data = hits.map((h) => ({ id: h.id, slug: h.slug, title: h.title, excerpt: h.excerpt, snippet: h.snippet, score: h.score, is_public: h.is_public }));
      return { ok: true, data, summary: `${hits.length} article(s) matched` };
    } catch (err) {
      return fail(`Knowledge base search failed: ${errMsg(err)}`);
    }
  },
});

/* ---------- kb.draft_article ---------- */
const DraftInput = z.object({ ticketIds: z.array(z.string().min(1).max(100)).min(1).max(10) });
type DraftInputT = z.infer<typeof DraftInput>;

registerTool<DraftInputT>({
  name: "kb.draft_article",
  module: "knowledge",
  description: "Draft a knowledge-base article (title + markdown body) from one or more resolved tickets. Returns the draft; it is NOT saved.",
  input: DraftInput,
  parameters: {
    type: "object",
    properties: { ticketIds: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 10 } },
    required: ["ticketIds"],
  },
  scope: "read",
  preview: (i) => `Draft KB article from ${i.ticketIds.length} ticket(s)`,
  async run(ctx, input) {
    try {
      const draft = await draftArticleFromTickets(ctx.userId, input.ticketIds);
      return { ok: true, data: draft, summary: `Drafted "${draft.title}"` };
    } catch (err) {
      return fail(`Drafting failed: ${errMsg(err)}`);
    }
  },
});
