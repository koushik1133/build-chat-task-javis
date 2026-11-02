import { NextResponse, type NextRequest } from "next/server";
import { requireScope } from "@/lib/auth/scope";
import { getTicket, updateTicket } from "@/lib/helpdesk/tickets";
import { UpdateTicketSchema, errorResponse, parseBody } from "@/lib/helpdesk/http";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/helpdesk/tickets/[id] — ticket + full thread (internal notes included). */
export async function GET(_req: NextRequest, ctx: Ctx) {
  try {
    const scope = await requireScope({ area: "helpdesk" });
    const { id } = await ctx.params;
    const ticket = await getTicket(scope.dataId, id);
    if (!ticket) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ ticket });
  } catch (err) {
    return errorResponse(err, "helpdesk.ticket.GET");
  }
}

/** PATCH /api/helpdesk/tickets/[id] — status, priority, assignee, tags, policy. */
export async function PATCH(req: NextRequest, ctx: Ctx) {
  try {
    const scope = await requireScope({ area: "helpdesk", edit: true });
    const { id } = await ctx.params;
    const body = await parseBody(req, UpdateTicketSchema);
    if (!body.ok) return body.res;
    const existing = await getTicket(scope.dataId, id);
    if (!existing) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const ticket = await updateTicket(
      scope.dataId,
      id,
      { ...body.data, requester_email: body.data.requester_email === "" ? null : body.data.requester_email },
      { actorId: scope.userId }
    );
    return NextResponse.json({ ticket });
  } catch (err) {
    return errorResponse(err, "helpdesk.ticket.PATCH");
  }
}
