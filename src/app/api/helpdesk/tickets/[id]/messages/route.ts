import { NextResponse, type NextRequest } from "next/server";
import { requireScope } from "@/lib/auth/scope";
import { addMessage, formatTicketNumber, getTicketRow } from "@/lib/helpdesk/tickets";
import { MessageSchema, errorResponse, parseBody } from "@/lib/helpdesk/http";
import { enqueueNotification } from "@/lib/notifications/outbox";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/helpdesk/tickets/[id]/messages — { body, is_internal }
 * Public replies are emailed to the requester through the notification outbox.
 */
export async function POST(req: NextRequest, ctx: Ctx) {
  try {
    const scope = await requireScope({ area: "helpdesk", edit: true });
    const { id } = await ctx.params;
    const body = await parseBody(req, MessageSchema);
    if (!body.ok) return body.res;
    const existing = await getTicketRow(scope.dataId, id);
    if (!existing) return NextResponse.json({ error: "not_found" }, { status: 404 });

    const { message, ticket } = await addMessage(scope.dataId, id, {
      author_kind: "agent",
      author_id: scope.userId,
      body: body.data.body,
      is_internal: body.data.is_internal ?? false,
    });

    let emailed = false;
    if (!message.is_internal && ticket.requester_email) {
      try {
        await enqueueNotification(scope.dataId, {
          channel: "email",
          recipient: ticket.requester_email,
          subject: `Re: ${ticket.subject} [${formatTicketNumber(ticket.number)}]`,
          body: `${message.body}\n\n—\n${scope.orgName}`,
          data: { ticketId: ticket.id, messageId: message.id, kind: "ticket.reply" },
        });
        emailed = true;
      } catch (err) {
        console.error("[helpdesk] reply email enqueue failed:", err);
      }
    }
    return NextResponse.json({ message, ticket, emailed }, { status: 201 });
  } catch (err) {
    return errorResponse(err, "helpdesk.messages.POST");
  }
}
