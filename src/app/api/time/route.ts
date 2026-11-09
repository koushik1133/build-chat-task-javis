import { NextResponse, type NextRequest } from "next/server";
import { requireScope } from "@/lib/auth/scope";
import { parseBody } from "@/lib/money/http";
import { dateParam, financeErrorResponse, idParam } from "@/lib/finance/http";
import { parseRef } from "@/lib/finance/expenses";
import { createTimeEntry, listTimeEntries, stopTimer, TimeEntryInputSchema } from "@/lib/finance/time";
import { normaliseCursor, page, parseListParams } from "@/lib/public-api/pagination";

export const runtime = "nodejs";

/** GET /api/time?from=&to=&ref=kind:id&running=1&unbilled=1&mine=1 */
export async function GET(req: NextRequest) {
  try {
    const scope = await requireScope({ area: "billing" });
    const sp = req.nextUrl.searchParams;
    const ref = parseRef(sp.get("ref"));
    const paged = sp.get("order") === "created" || sp.has("cursor");
    const list = parseListParams(req.nextUrl, { limit: 50 });
    if (paged && list.badCursor) return NextResponse.json({ error: "invalid cursor" }, { status: 400 });
    const rows = await listTimeEntries(scope.dataId, {
      from: dateParam(req, "from"),
      to: dateParam(req, "to"),
      refKind: ref?.refKind,
      refId: ref?.refId,
      memberId: sp.get("mine") === "1" ? scope.userId : null,
      runningOnly: sp.get("running") === "1",
      unbilledOnly: sp.get("unbilled") === "1",
      ...(paged ? { order: "created" as const, cursor: list.cursor, limit: list.limit + 1 } : {}),
    });
    if (!paged) return NextResponse.json({ entries: rows, member_id: scope.userId, next_cursor: null });
    const pg = page(rows, list.limit, (r) => normaliseCursor({ created_at: r.created_at, id: r.id }));
    return NextResponse.json({ entries: pg.data, member_id: scope.userId, next_cursor: pg.next_cursor });
  } catch (err) {
    return financeErrorResponse(err, "time.GET");
  }
}

/** POST /api/time — with only started_at (or nothing) this starts a running timer. */
export async function POST(req: NextRequest) {
  try {
    const scope = await requireScope({ area: "billing", edit: true });
    const body = await parseBody(req, TimeEntryInputSchema);
    if (!body.ok) return body.res;
    const entry = await createTimeEntry(scope.dataId, body.data, scope.userId);
    return NextResponse.json({ entry }, { status: 201 });
  } catch (err) {
    return financeErrorResponse(err, "time.POST");
  }
}

/** PATCH /api/time?id= — stop the running timer. */
export async function PATCH(req: NextRequest) {
  try {
    const scope = await requireScope({ area: "billing", edit: true });
    const id = idParam(req);
    if (!id) return NextResponse.json({ error: "missing_id" }, { status: 400 });
    const entry = await stopTimer(scope.dataId, id);
    return NextResponse.json({ entry });
  } catch (err) {
    return financeErrorResponse(err, "time.PATCH");
  }
}
