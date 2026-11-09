import { NextResponse, type NextRequest } from "next/server";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { rateLimitAsync } from "@/lib/request-limits";
import { resolveDataset, runReport } from "@/lib/reports/query";
import { getSavedReport } from "@/lib/reports/store";
import { buildReportExport } from "@/lib/reports/render";
import { paramId, reportsError } from "@/lib/reports/http";

export const runtime = "nodejs";

/** GET /api/reports/saved/[id]/export?format=csv|pdf */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  let scope;
  try {
    scope = await requireScope({ area: "reports" });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const rl = await rateLimitAsync(`reports:export:${scope.dataId}`, 30, 60_000);
  if (!rl.allowed) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  const format = req.nextUrl.searchParams.get("format") === "pdf" ? "pdf" : "csv";
  try {
    const report = await getSavedReport(scope.dataId, scope.userId, await paramId(ctx));
    if (!report) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const dataset = await resolveDataset(scope.dataId, report.spec.dataset);
    if (!dataset) return NextResponse.json({ error: "dataset_unavailable" }, { status: 404 });
    if (!scope.can(dataset.area)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
    const result = await runReport(scope.dataId, report.spec, { dataset });
    return buildReportExport(scope.dataId, report, result, format);
  } catch (err) {
    return reportsError(err, "reports.saved.id.export.GET");
  }
}
