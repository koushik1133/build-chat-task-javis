import { NextResponse, type NextRequest } from "next/server";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { recordAudit } from "@/lib/audit";
import { SchedulePatchSchema, deleteSchedule, getSchedule, updateSchedule } from "@/lib/reports/store";
import { paramId, parseJson, reportsError } from "@/lib/reports/http";

export const runtime = "nodejs";
type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, ctx: Ctx) {
  let scope;
  try {
    scope = await requireScope({ area: "reports" });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const schedule = await getSchedule(scope.dataId, await paramId(ctx));
    return schedule ? NextResponse.json({ schedule }) : NextResponse.json({ error: "not_found" }, { status: 404 });
  } catch (err) {
    return reportsError(err, "reports.schedules.id.GET");
  }
}

export async function PATCH(req: NextRequest, ctx: Ctx) {
  let scope;
  try {
    scope = await requireScope({ area: "reports", edit: true });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const body = await parseJson(req, SchedulePatchSchema);
  if (!body.ok) return body.res;
  try {
    const id = await paramId(ctx);
    const schedule = await updateSchedule(scope.dataId, id, body.data);
    if (!schedule) return NextResponse.json({ error: "not_found" }, { status: 404 });
    await recordAudit(scope, { action: "report.schedule_updated", entity: "report_schedule", entityId: id, after: { enabled: schedule.enabled, cadence: schedule.cadence }, req });
    return NextResponse.json({ schedule });
  } catch (err) {
    return reportsError(err, "reports.schedules.id.PATCH");
  }
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  let scope;
  try {
    scope = await requireScope({ area: "reports", edit: true });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const id = await paramId(ctx);
    const ok = await deleteSchedule(scope.dataId, id);
    if (!ok) return NextResponse.json({ error: "not_found" }, { status: 404 });
    await recordAudit(scope, { action: "report.schedule_deleted", entity: "report_schedule", entityId: id, req });
    return NextResponse.json({ deleted: true });
  } catch (err) {
    return reportsError(err, "reports.schedules.id.DELETE");
  }
}
