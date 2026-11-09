import { NextResponse, type NextRequest } from "next/server";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { recordAudit } from "@/lib/audit";
import { resolveDataset } from "@/lib/reports/query";
import { SavedReportPatchSchema, deleteSavedReport, getSavedReport, listSchedules, updateSavedReport } from "@/lib/reports/store";
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
    const id = await paramId(ctx);
    const report = await getSavedReport(scope.dataId, scope.userId, id);
    if (!report) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const schedules = await listSchedules(scope.dataId, id);
    return NextResponse.json({ report, schedules });
  } catch (err) {
    return reportsError(err, "reports.saved.id.GET");
  }
}

export async function PATCH(req: NextRequest, ctx: Ctx) {
  let scope;
  try {
    scope = await requireScope({ area: "reports", edit: true });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const body = await parseJson(req, SavedReportPatchSchema);
  if (!body.ok) return body.res;
  try {
    const id = await paramId(ctx);
    if (body.data.spec) {
      const ds = await resolveDataset(scope.dataId, body.data.spec.dataset);
      if (!ds) return NextResponse.json({ error: "dataset_unavailable" }, { status: 404 });
      if (!scope.can(ds.area)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    const report = await updateSavedReport(scope.dataId, scope.userId, id, body.data);
    if (!report) return NextResponse.json({ error: "not_found" }, { status: 404 });
    await recordAudit(scope, { action: "report.updated", entity: "saved_report", entityId: id, after: { name: report.name }, req });
    return NextResponse.json({ report });
  } catch (err) {
    return reportsError(err, "reports.saved.id.PATCH");
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
    const ok = await deleteSavedReport(scope.dataId, scope.userId, id);
    if (!ok) return NextResponse.json({ error: "not_found" }, { status: 404 });
    await recordAudit(scope, { action: "report.deleted", entity: "saved_report", entityId: id, req });
    return NextResponse.json({ deleted: true });
  } catch (err) {
    return reportsError(err, "reports.saved.id.DELETE");
  }
}
