import { NextResponse, type NextRequest } from "next/server";
import { recordAudit } from "@/lib/audit";
import { parseBody } from "@/lib/money/http";
import { workforceError, workforceScope } from "@/lib/workforce/http";
import { createShift, listShifts, listSwaps, ShiftInputSchema, weekView } from "@/lib/workforce/shifts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/workforce/shifts?week=YYYY-MM-DD — week view (rota grid + pending swaps).
 * GET /api/workforce/shifts?from=&to=&staff_id= — flat list.
 */
export async function GET(req: NextRequest) {
  const s = await workforceScope(req, false);
  if (!s.ok) return s.res;
  const q = req.nextUrl.searchParams;
  try {
    if (q.has("from") || q.has("to")) {
      const shifts = await listShifts(s.scope.dataId, { from: q.get("from"), to: q.get("to"), staffId: q.get("staff_id"), status: q.get("status"), limit: Number(q.get("limit")) || undefined });
      return NextResponse.json({ shifts });
    }
    const [week, swaps] = await Promise.all([weekView(s.scope.dataId, q.get("week")), listSwaps(s.scope.dataId, { status: "requested", limit: 100 })]);
    return NextResponse.json({ ...week, swaps });
  } catch (err) {
    return workforceError(err, "workforce.shifts.list");
  }
}

/** POST /api/workforce/shifts — create a (draft) shift. 409 with `conflicts` on overlap / leave. */
export async function POST(req: NextRequest) {
  const s = await workforceScope(req, true);
  if (!s.ok) return s.res;
  const parsed = await parseBody(req, ShiftInputSchema, 16_384);
  if (!parsed.ok) return parsed.res;
  try {
    const shift = await createShift(s.scope.dataId, parsed.data);
    void recordAudit(s.scope, { action: "create", entity: "shift", entityId: shift.id, after: { staff_id: shift.staff_id, starts_at: shift.starts_at, ends_at: shift.ends_at }, req }).catch(() => undefined);
    return NextResponse.json({ shift }, { status: 201 });
  } catch (err) {
    return workforceError(err, "workforce.shifts.create");
  }
}
