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

/* ═══ Phase 6: ticket creation, assignment, SLA ═══ */
import { createTicket, getTicketRow, listPolicies, updateTicket } from "@/lib/helpdesk/tickets";
import { createArticle, getArticle, updateArticle } from "@/lib/kb/articles";

/* ---------- helpdesk.create_ticket ---------- */
const CreateTicketInput = z.object({
  subject: z.string().trim().min(1).max(200),
  body: z.string().max(20_000).optional(),
  priority: z.enum(TICKET_PRIORITIES).optional(),
  contact_id: z.string().max(100).optional(),
  requester_email: z.string().email().max(320).optional(),
  requester_name: z.string().max(200).optional(),
  tags: z.array(z.string().max(40)).max(20).optional(),
});
type CreateTicketT = z.infer<typeof CreateTicketInput>;

registerTool<CreateTicketT>({
  name: "helpdesk.create_ticket",
  module: "helpdesk",
  description: "Open a new support ticket (subject, optional first message, priority, requester). SLA due times are computed from the default policy.",
  input: CreateTicketInput,
  parameters: {
    type: "object",
    properties: {
      subject: { type: "string" },
      body: { type: "string", description: "First message on the ticket" },
      priority: { type: "string", enum: [...TICKET_PRIORITIES] },
      contact_id: { type: "string", description: "CRM contact id of the requester (optional)" },
      requester_email: { type: "string" },
      requester_name: { type: "string" },
      tags: { type: "array", items: { type: "string" } },
    },
    required: ["subject"],
  },
  scope: "write",
  requiresApproval: false,
  preview: (i) => `Create ticket "${i.subject}"${i.priority ? ` (${i.priority})` : ""}`,
  async run(ctx, input) {
    try {
      const t = await createTicket(ctx.userId, {
        subject: input.subject,
        body: input.body ?? null,
        priority: input.priority,
        source: "agent",
        contact_id: input.contact_id ?? null,
        requester_email: input.requester_email ?? null,
        requester_name: input.requester_name ?? null,
        tags: input.tags,
        author_kind: "ai",
        author_id: ctx.agentId ? `agent:${ctx.agentId}` : ctx.runId,
      });
      return { ok: true, data: summarise(t), summary: `Opened ticket ${formatTicketNumber(t.number)}: ${t.subject}` };
    } catch (err) {
      return fail(`Could not create ticket: ${errMsg(err)}`);
    }
  },
});

/* ---------- helpdesk.assign ---------- */
const AssignInput = z.object({
  ticket_id: z.string().min(1).max(100),
  assigned_to: z.string().max(100).nullable().describe("Member user id, or null to unassign"),
});
type AssignT = z.infer<typeof AssignInput>;

registerTool<AssignT>({
  name: "helpdesk.assign",
  module: "helpdesk",
  description: "Assign a ticket to a team member (or unassign with null).",
  input: AssignInput,
  parameters: {
    type: "object",
    properties: { ticket_id: { type: "string" }, assigned_to: { type: ["string", "null"], description: "Member user id or null" } },
    required: ["ticket_id", "assigned_to"],
  },
  scope: "write",
  requiresApproval: false,
  preview: (i) => (i.assigned_to ? `Assign ticket ${i.ticket_id} to ${i.assigned_to}` : `Unassign ticket ${i.ticket_id}`),
  async run(ctx, input) {
    try {
      if (!(await getTicketRow(ctx.userId, input.ticket_id))) return fail("Ticket not found");
      const t = await updateTicket(ctx.userId, input.ticket_id, { assigned_to: input.assigned_to }, { actorId: ctx.agentId ? `agent:${ctx.agentId}` : null });
      return { ok: true, data: summarise(t), summary: `${formatTicketNumber(t.number)} ${input.assigned_to ? `assigned to ${input.assigned_to}` : "unassigned"}` };
    } catch (err) {
      return fail(`Assign failed: ${errMsg(err)}`);
    }
  },
});

/* ---------- helpdesk.set_sla ---------- */
const SetSlaInput = z.object({
  ticket_id: z.string().min(1).max(100),
  sla_policy_id: z.string().max(100).optional().describe("Policy id; omit to only change priority"),
  priority: z.enum(TICKET_PRIORITIES).optional(),
});
type SetSlaT = z.infer<typeof SetSlaInput>;

registerTool<SetSlaT>({
  name: "helpdesk.set_sla",
  module: "helpdesk",
  description: "Change a ticket's SLA policy and/or priority; due times are recomputed. Call with no ticket changes to list the available policies.",
  input: SetSlaInput,
  parameters: {
    type: "object",
    properties: {
      ticket_id: { type: "string" },
      sla_policy_id: { type: "string" },
      priority: { type: "string", enum: [...TICKET_PRIORITIES] },
    },
    required: ["ticket_id"],
  },
  scope: "write",
  requiresApproval: false,
  preview: (i) => `Set SLA on ticket ${i.ticket_id}${i.sla_policy_id ? ` → policy ${i.sla_policy_id}` : ""}${i.priority ? `, priority ${i.priority}` : ""}`,
  async run(ctx, input) {
    try {
      if (!(await getTicketRow(ctx.userId, input.ticket_id))) return fail("Ticket not found");
      const policies = await listPolicies(ctx.userId);
      if (!input.sla_policy_id && !input.priority) {
        return { ok: true, data: { policies: policies.map((p) => ({ id: p.id, name: p.name, first_response_minutes: p.first_response_minutes, resolution_minutes: p.resolution_minutes, is_default: p.is_default })) }, summary: `${policies.length} SLA polic${policies.length === 1 ? "y" : "ies"} available` };
      }
      if (input.sla_policy_id && !policies.some((p) => p.id === input.sla_policy_id)) return fail("SLA policy not found");
      const t = await updateTicket(ctx.userId, input.ticket_id, { sla_policy_id: input.sla_policy_id, priority: input.priority }, { actorId: ctx.agentId ? `agent:${ctx.agentId}` : null });
      return { ok: true, data: summarise(t), summary: `${formatTicketNumber(t.number)}: SLA updated (first response due ${t.first_response_due_at ?? "n/a"})` };
    } catch (err) {
      return fail(`SLA update failed: ${errMsg(err)}`);
    }
  },
});

/* ---------- kb.create_article ---------- */
const CreateArticleInput = z.object({
  title: z.string().trim().min(1).max(200),
  body_md: z.string().max(200_000),
  category: z.string().max(100).optional(),
  tags: z.array(z.string().max(40)).max(30).optional(),
  publish: z.boolean().optional().describe("Publish immediately (default: save as draft)"),
  is_public: z.boolean().optional().describe("Show in the public help center"),
});
type CreateArticleT = z.infer<typeof CreateArticleInput>;

registerTool<CreateArticleT>({
  name: "kb.create_article",
  module: "knowledge",
  description: "Create a knowledge-base article from markdown. Saved as a draft unless publish=true.",
  input: CreateArticleInput,
  parameters: {
    type: "object",
    properties: {
      title: { type: "string" },
      body_md: { type: "string", description: "Markdown body" },
      category: { type: "string" },
      tags: { type: "array", items: { type: "string" } },
      publish: { type: "boolean" },
      is_public: { type: "boolean" },
    },
    required: ["title", "body_md"],
  },
  scope: "write",
  requiresApproval: (i) => Boolean(i.publish || i.is_public),
  preview: (i) => `${i.publish ? "Publish" : "Draft"} article "${i.title}"`,
  async run(ctx, input) {
    try {
      const a = await createArticle(ctx.userId, {
        title: input.title,
        body_md: input.body_md,
        category: input.category ?? null,
        tags: input.tags,
        status: input.publish ? "published" : "draft",
        is_public: input.is_public ?? false,
      });
      return { ok: true, data: { id: a.id, slug: a.slug, title: a.title, status: a.status, is_public: a.is_public }, summary: `${a.status === "published" ? "Published" : "Drafted"} article "${a.title}" (${a.slug})` };
    } catch (err) {
      return fail(`Could not create article: ${errMsg(err)}`);
    }
  },
});

/* ---------- kb.publish_article ---------- */
const PublishArticleInput = z.object({ article_id: z.string().min(1).max(100), is_public: z.boolean().optional() });
type PublishArticleT = z.infer<typeof PublishArticleInput>;

registerTool<PublishArticleT>({
  name: "kb.publish_article",
  module: "knowledge",
  description: "Publish a draft article (optionally making it public in the help center). Needs approval.",
  input: PublishArticleInput,
  parameters: { type: "object", properties: { article_id: { type: "string" }, is_public: { type: "boolean" } }, required: ["article_id"] },
  scope: "write",
  requiresApproval: true,
  preview: (i) => `Publish article ${i.article_id}${i.is_public ? " (public)" : ""}`,
  async run(ctx, input) {
    try {
      if (!(await getArticle(ctx.userId, input.article_id))) return fail("Article not found");
      const a = await updateArticle(ctx.userId, input.article_id, { status: "published", ...(input.is_public === undefined ? {} : { is_public: input.is_public }) });
      return { ok: true, data: { id: a.id, slug: a.slug, status: a.status, is_public: a.is_public, published_at: a.published_at }, summary: `Published "${a.title}"` };
    } catch (err) {
      return fail(`Publish failed: ${errMsg(err)}`);
    }
  },
});
