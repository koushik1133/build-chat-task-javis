import { addMessage } from "@/lib/helpdesk/tickets";
import { ROUTES } from "@/lib/public-api/registry";
import { op } from "@/lib/public-api/handler";
import { ticketMessageView, ticketView } from "@/lib/public-api/views";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = op(ROUTES.replyTicket, async ({ principal, params, body }) => {
  const { message, ticket } = await addMessage(principal.dataId, params.id, {
    author_kind: body.author_kind ?? "agent",
    author_id: `api_key:${principal.keyId}`,
    body: body.body,
    is_internal: body.is_internal ?? false,
  });
  return { data: { message: ticketMessageView(message), ticket: ticketView(ticket) }, status: 201 };
});
