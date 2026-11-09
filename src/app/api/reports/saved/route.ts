import { NextResponse, type NextRequest } from "next/server";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { recordAudit } from "@/lib/audit";
import { resolveDataset } from "@/lib/reports/query";
import { SavedReportInputSchema, createSavedReport, listSavedReports } from "@/lib/reports/store";
import { parseJson, reportsError } from "@/lib/reports/http";

export const runtime = "nodejs";

/** GET /api/reports/saved — org-visible reports plus the caller's private ones. */
export async function GET() {
  let scope;
  try {
    scope = await requireScope({ area: "reports" });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    return NextResponse.json({ reports: await listSavedReports(scope.dataId, scope.userId) });
  } catch (err) {
    return reportsError(err, "reports.saved.GET");
  }
}

/** POST /api/reports/saved — save a spec + chart. */
export async function POST(req: NextRequest) {
  let scope;
  try {
    scope = await requireScope({ area: "reports", edit: true });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const body = await parseJson(req, SavedReportInputSchema);
  if (!body.ok) return body.res;
  try {
    const ds = await resolveDataset(scope.dataId, body.data.spec.dataset);
    if (!ds) return NextResponse.json({ error: "dataset_unavailable" }, { status: 404 });
    if (!scope.can(ds.area)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
    const report = await createSavedReport(scope.dataId, scope.userId, body.data);
    await recordAudit(scope, { action: "report.saved", entity: "saved_report", entityId: report.id, after: { name: report.name, dataset: report.spec.dataset }, req });
    return NextResponse.json({ report }, { status: 201 });
  } catch (err) {
    return reportsError(err, "reports.saved.POST");
  }
}
