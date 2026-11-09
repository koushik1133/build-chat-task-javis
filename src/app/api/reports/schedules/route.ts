import { NextResponse, type NextRequest } from "next/server";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { recordAudit } from "@/lib/audit";
import { ScheduleInputSchema, createSchedule, getSavedReport, listSchedules } from "@/lib/reports/store";
import { parseJson, reportsError } from "@/lib/reports/http";

export const runtime = "nodejs";

/** GET /api/reports/schedules?report_id= */
export async function GET(req: NextRequest) {
  let scope;
  try {
    scope = await requireScope({ area: "reports" });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    return NextResponse.json({ schedules: await listSchedules(scope.dataId, req.nextUrl.searchParams.get("report_id")) });
  } catch (err) {
    return reportsError(err, "reports.schedules.GET");
  }
}

/** POST /api/reports/schedules */
export async function POST(req: NextRequest) {
  let scope;
  try {
    scope = await requireScope({ area: "reports", edit: true });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const body = await parseJson(req, ScheduleInputSchema);
  if (!body.ok) return body.res;
  try {
    const report = await getSavedReport(scope.dataId, scope.userId, body.data.report_id);
    if (!report) return NextResponse.json({ error: "not_found", detail: "Report not found" }, { status: 404 });
    const schedule = await createSchedule(scope.dataId, scope.userId, body.data);
    await recordAudit(scope, { action: "report.scheduled", entity: "report_schedule", entityId: schedule.id, after: { report_id: report.id, cadence: schedule.cadence, recipients: schedule.recipients.length }, req });
    return NextResponse.json({ schedule }, { status: 201 });
  } catch (err) {
    return reportsError(err, "reports.schedules.POST");
  }
}
