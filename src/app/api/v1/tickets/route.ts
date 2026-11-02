import { createTicket, listTickets } from "@/lib/helpdesk/tickets";
import { ROUTES } from "@/lib/public-api/registry";
import { op } from "@/lib/public-api/handler";
import { page } from "@/lib/public-api/pagination";
import { ticketView } from "@/lib/public-api/views";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = op(ROUTES.listTickets, async ({ principal, query, list }) => {
  const rows = await listTickets(principal.dataId, {
    status: query.status ?? null,
    priority: query.priority ?? null,
    contact_id: query.contact_id ?? null,
    q: query.q ?? list.q,
    order: "created",
    cursor: list.cursor,
    limit: list.limit + 1,
  });
  const p = page(rows, list.limit, (r) => ({ created_at: r.created_at, id: r.id }));
  return { data: p.data.map(ticketView), meta: { next_cursor: p.next_cursor } };
});

export const POST = op(ROUTES.createTicket, async ({ principal, body }) => {
  const row = await createTicket(principal.dataId, { ...body, source: body.source ?? "manual", author_kind: "agent", author_id: `api_key:${principal.keyId}` });
  return { data: ticketView(row), status: 201 };
});
