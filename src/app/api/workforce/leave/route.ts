import { NextResponse, type NextRequest } from "next/server";
import { recordAudit } from "@/lib/audit";
import { parseBody } from "@/lib/money/http";
import { workforceError, workforceScope } from "@/lib/workforce/http";
import { LeaveRequestSchema, listLeave, requestLeave } from "@/lib/workforce/leave";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/workforce/leave?status=&staff_id=&from=&to= */
export async function GET(req: NextRequest) {
  const s = await workforceScope(req, false);
  if (!s.ok) return s.res;
  const q = req.nextUrl.searchParams;
  try {
    const leave = await listLeave(s.scope.dataId, { status: q.get("status"), staffId: q.get("staff_id"), from: q.get("from"), to: q.get("to"), limit: Number(q.get("limit")) || undefined });
    return NextResponse.json({ leave });
  } catch (err) {
    return workforceError(err, "workforce.leave.list");
  }
}

/** POST /api/workforce/leave — request leave on behalf of a staff member (balance-checked, 409 when short). */
export async function POST(req: NextRequest) {
  const s = await workforceScope(req, true);
  if (!s.ok) return s.res;
  const parsed = await parseBody(req, LeaveRequestSchema, 8_192);
  if (!parsed.ok) return parsed.res;
  try {
    const leave = await requestLeave(s.scope.dataId, parsed.data, s.scope.userId);
    void recordAudit(s.scope, { action: "create", entity: "leave_request", entityId: leave.id, after: { staff_id: leave.staff_id, kind: leave.kind, hours: leave.hours }, req }).catch(() => undefined);
    return NextResponse.json({ leave }, { status: 201 });
  } catch (err) {
    return workforceError(err, "workforce.leave.create");
  }
}
