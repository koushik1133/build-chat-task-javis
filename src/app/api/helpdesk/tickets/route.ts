import { NextResponse, type NextRequest } from "next/server";
import { requireScope } from "@/lib/auth/scope";
import { createTicket, listPolicies, listTickets } from "@/lib/helpdesk/tickets";
import { CreateTicketSchema, errorResponse, parseBody } from "@/lib/helpdesk/http";

export const runtime = "nodejs";

/** GET /api/helpdesk/tickets?status=open|pending|resolved|closed|active|all&q=&priority= */
export async function GET(req: NextRequest) {
  try {
    const scope = await requireScope({ area: "helpdesk" });
    const sp = req.nextUrl.searchParams;
    const [tickets, policies] = await Promise.all([
      listTickets(scope.dataId, {
        status: sp.get("status") ?? "active",
        q: sp.get("q"),
        priority: sp.get("priority"),
        contact_id: sp.get("contact_id"),
        limit: Number(sp.get("limit") ?? 100) || 100,
      }),
      listPolicies(scope.dataId),
    ]);
    return NextResponse.json({ tickets, policies });
  } catch (err) {
    return errorResponse(err, "helpdesk.tickets.GET");
  }
}

/** POST /api/helpdesk/tickets */
export async function POST(req: NextRequest) {
  try {
    const scope = await requireScope({ area: "helpdesk", edit: true });
    const body = await parseBody(req, CreateTicketSchema);
    if (!body.ok) return body.res;
    const ticket = await createTicket(scope.dataId, {
      ...body.data,
      requester_email: body.data.requester_email || null,
      source: body.data.source ?? "manual",
      author_kind: "agent",
      author_id: scope.userId,
    });
    return NextResponse.json({ ticket }, { status: 201 });
  } catch (err) {
    return errorResponse(err, "helpdesk.tickets.POST");
  }
}
