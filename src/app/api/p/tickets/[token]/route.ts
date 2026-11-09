import { NextRequest, NextResponse } from "next/server";
import { queryOne } from "@/lib/dsql";
import { createTicket, formatTicketNumber, listMessages, listTickets, type TicketRow } from "@/lib/helpdesk/tickets";
import { PortalTicketSchema } from "@/lib/helpdesk/http";
import { parseBody, publicRateLimit } from "@/lib/money/http";
import { rateLimitAsync } from "@/lib/request-limits";
import { resolveShareToken } from "@/lib/share-tokens";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ token: string }> };

/** Whitelisted ticket view for the client portal: no assignee, no internal notes, no SLA internals. */
function toPortalTicket(t: TicketRow) {
  return {
    id: t.id,
    number: formatTicketNumber(t.number),
    subject: t.subject,
    status: t.status,
    priority: t.priority,
    created_at: t.created_at,
    updated_at: t.updated_at,
    resolved_at: t.resolved_at,
  };
}

async function resolve(req: NextRequest, ctx: Ctx) {
  const limited = await publicRateLimit(req, "tickets");
  if (limited) return { res: limited };
  const { token } = await ctx.params;
  const t = await resolveShareToken("portal", token);
  if (!t) return { res: NextResponse.json({ error: "not_found" }, { status: 404 }) };
  const contact = await queryOne<{ id: string; full_name: string; email: string | null }>(
    `SELECT id, full_name, email FROM crm_contacts WHERE user_id = $1 AND id = $2`,
    [t.user_id, t.entity_id]
  );
  if (!contact) return { res: NextResponse.json({ error: "not_found" }, { status: 404 }) };
  return { dataId: t.user_id, contact, tokenId: t.id };
}

/** GET /api/p/tickets/[token] — the contact's tickets (+ public thread when ?id=). */
export async function GET(req: NextRequest, ctx: Ctx) {
  try {
    const r = await resolve(req, ctx);
    if ("res" in r) return r.res;
    const id = req.nextUrl.searchParams.get("id");
    if (id) {
      const ticket = (await listTickets(r.dataId, { contact_id: r.contact.id, status: "all", limit: 200 })).find((t) => t.id === id);
      if (!ticket) return NextResponse.json({ error: "not_found" }, { status: 404 });
      const messages = (await listMessages(r.dataId, ticket.id, { includeInternal: false })).map((m) => ({
        id: m.id,
        author_kind: m.author_kind === "customer" ? "you" : m.author_kind === "system" ? "system" : "support",
        body: m.body,
        created_at: m.created_at,
      }));
      return NextResponse.json({ ticket: toPortalTicket(ticket), messages });
    }
    const tickets = await listTickets(r.dataId, { contact_id: r.contact.id, status: "all", limit: 100 });
    return NextResponse.json({ tickets: tickets.map(toPortalTicket) });
  } catch (err) {
    console.error("[portal.tickets] GET failed:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

/** POST /api/p/tickets/[token] — { subject, body, priority? } → new ticket (source=portal). */
export async function POST(req: NextRequest, ctx: Ctx) {
  try {
    const r = await resolve(req, ctx);
    if ("res" in r) return r.res;
    // Ticket creation is a write that fans out (numbering, events, agent notifications):
    // cap it per portal link on top of the per-IP read limit.
    if (!(await rateLimitAsync(`p:tickets:create:${r.tokenId}`, 10, 60 * 60 * 1000)).allowed) {
      return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: { "Retry-After": "3600" } });
    }
    const body = await parseBody(req, PortalTicketSchema);
    if (!body.ok) return body.res;
    const ticket = await createTicket(r.dataId, {
      subject: body.data.subject,
      body: body.data.body,
      priority: body.data.priority ?? "normal",
      source: "portal",
      contact_id: r.contact.id,
      requester_email: r.contact.email,
      requester_name: r.contact.full_name,
      author_kind: "customer",
      author_id: r.contact.id,
    });
    return NextResponse.json({ ticket: toPortalTicket(ticket) }, { status: 201 });
  } catch (err) {
    console.error("[portal.tickets] POST failed:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
