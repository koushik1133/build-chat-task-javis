import { NextResponse, type NextRequest } from "next/server";
import { requireScope } from "@/lib/auth/scope";
import { memberErrorResponse } from "@/lib/memberships/http";
import { SUB_STATUSES, type SubStatus } from "@/lib/memberships/pure";
import { listSubscriptions } from "@/lib/memberships/store";
import { normaliseCursor, page, parseListParams } from "@/lib/public-api/pagination";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/memberships/subscriptions?status=&plan_id=&q=&cursor=&limit= */
export async function GET(req: NextRequest) {
  try {
    const scope = await requireScope({ area: "billing", edit: false });
    const url = new URL(req.url);
    const list = parseListParams(url, { limit: 50 });
    if (list.badCursor) return NextResponse.json({ error: "invalid cursor" }, { status: 400 });
    const status = url.searchParams.get("status");
    if (status && !(SUB_STATUSES as readonly string[]).includes(status)) return NextResponse.json({ error: "invalid status" }, { status: 400 });
    const rows = await listSubscriptions(scope.dataId, {
      status: (status as SubStatus | null) || null,
      planId: url.searchParams.get("plan_id"),
      q: list.q,
      cursor: list.cursor,
      limit: list.limit + 1,
    });
    const pg = page(rows, list.limit, (r) => normaliseCursor({ created_at: r.created_at, id: r.id }));
    return NextResponse.json({ subscriptions: pg.data, next_cursor: pg.next_cursor });
  } catch (err) {
    return memberErrorResponse(err, "memberships.subscriptions.GET");
  }
}
