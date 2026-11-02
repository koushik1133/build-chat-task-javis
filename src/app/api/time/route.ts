import { NextResponse, type NextRequest } from "next/server";
import { requireScope } from "@/lib/auth/scope";
import { parseBody } from "@/lib/money/http";
import { dateParam, financeErrorResponse, idParam } from "@/lib/finance/http";
import { parseRef } from "@/lib/finance/expenses";
import { createTimeEntry, listTimeEntries, stopTimer, TimeEntryInputSchema } from "@/lib/finance/time";

export const runtime = "nodejs";

/** GET /api/time?from=&to=&ref=kind:id&running=1&unbilled=1&mine=1 */
export async function GET(req: NextRequest) {
  try {
    const scope = await requireScope({ area: "billing" });
    const sp = req.nextUrl.searchParams;
    const ref = parseRef(sp.get("ref"));
    const entries = await listTimeEntries(scope.dataId, {
      from: dateParam(req, "from"),
      to: dateParam(req, "to"),
      refKind: ref?.refKind,
      refId: ref?.refId,
      memberId: sp.get("mine") === "1" ? scope.userId : null,
      runningOnly: sp.get("running") === "1",
      unbilledOnly: sp.get("unbilled") === "1",
    });
    return NextResponse.json({ entries, member_id: scope.userId });
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
