import { getTicket } from "@/lib/helpdesk/tickets";
import { ROUTES } from "@/lib/public-api/registry";
import { op, mustFind } from "@/lib/public-api/handler";
import { ticketMessageView, ticketView } from "@/lib/public-api/views";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = op(ROUTES.getTicket, async ({ principal, params }) => {
  const t = mustFind(await getTicket(principal.dataId, params.id, { includeInternal: true }), "Ticket");
  const { messages, ...row } = t;
  return { data: { ...ticketView(row), messages: messages.map(ticketMessageView) } };
});
