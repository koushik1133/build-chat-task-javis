import { NextResponse, type NextRequest } from "next/server";
import { recordAudit } from "@/lib/audit";
import { parseBody } from "@/lib/money/http";
import { AttendanceInputSchema, createAttendance, listAttendance } from "@/lib/workforce/attendance";
import { workforceError, workforceScope } from "@/lib/workforce/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/workforce/attendance?from=&to=&staff_id= (ISO instants) */
export async function GET(req: NextRequest) {
  const s = await workforceScope(req, false);
  if (!s.ok) return s.res;
  const q = req.nextUrl.searchParams;
  try {
    const attendance = await listAttendance(s.scope.dataId, { from: q.get("from"), to: q.get("to"), staffId: q.get("staff_id"), limit: Number(q.get("limit")) || undefined });
    return NextResponse.json({ attendance });
  } catch (err) {
    return workforceError(err, "workforce.attendance.list");
  }
}

/** POST /api/workforce/attendance — manual clock in/out row. */
export async function POST(req: NextRequest) {
  const s = await workforceScope(req, true);
  if (!s.ok) return s.res;
  const parsed = await parseBody(req, AttendanceInputSchema, 4_096);
  if (!parsed.ok) return parsed.res;
  try {
    const attendance = await createAttendance(s.scope.dataId, parsed.data, "manual");
    void recordAudit(s.scope, { action: "create", entity: "attendance", entityId: attendance.id, after: parsed.data, req }).catch(() => undefined);
    return NextResponse.json({ attendance }, { status: 201 });
  } catch (err) {
    return workforceError(err, "workforce.attendance.create");
  }
}
