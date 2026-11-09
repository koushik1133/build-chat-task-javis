import { NextResponse, type NextRequest } from "next/server";
import { requireScope } from "@/lib/auth/scope";
import { createTicket, listPolicies, listTickets } from "@/lib/helpdesk/tickets";
import { CreateTicketSchema, errorResponse, parseBody } from "@/lib/helpdesk/http";
import { normaliseCursor, page, parseListParams } from "@/lib/public-api/pagination";

export const runtime = "nodejs";

/**
 * GET /api/helpdesk/tickets?status=open|pending|resolved|closed|active|all&q=&priority=&cursor=&limit=
 *
 * Keyset-paginated newest-first (created_at DESC, id DESC); filters and search
 * compose with the cursor. First call (no cursor) returns 50 rows + `next_cursor`.
 */
export async function GET(req: NextRequest) {
  try {
    const scope = await requireScope({ area: "helpdesk" });
    const sp = req.nextUrl.searchParams;
    const list = parseListParams(req.nextUrl, { limit: 50 });
    if (list.badCursor) return NextResponse.json({ error: "invalid cursor" }, { status: 400 });
    const [rows, policies] = await Promise.all([
      listTickets(scope.dataId, {
        status: sp.get("status") ?? "active",
        q: list.q,
        priority: sp.get("priority"),
        contact_id: sp.get("contact_id"),
        limit: list.limit + 1,
        order: "created",
        cursor: list.cursor,
      }),
      listPolicies(scope.dataId),
    ]);
    const pg = page(rows, list.limit, (r) => normaliseCursor({ created_at: r.created_at, id: r.id }));
    return NextResponse.json({ tickets: pg.data, policies, next_cursor: pg.next_cursor });
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
