import { NextResponse, type NextRequest } from "next/server";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { rateLimitAsync } from "@/lib/request-limits";
import { resolveDataset, runReport } from "@/lib/reports/query";
import { getSavedReport } from "@/lib/reports/store";
import { paramId, reportsError } from "@/lib/reports/http";

export const runtime = "nodejs";

/** POST /api/reports/saved/[id]/run — run a saved report. */
export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  let scope;
  try {
    scope = await requireScope({ area: "reports" });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const rl = await rateLimitAsync(`reports:run:${scope.dataId}`, 60, 60_000);
  if (!rl.allowed) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  try {
    const report = await getSavedReport(scope.dataId, scope.userId, await paramId(ctx));
    if (!report) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const dataset = await resolveDataset(scope.dataId, report.spec.dataset);
    if (!dataset) return NextResponse.json({ error: "dataset_unavailable" }, { status: 404 });
    if (!scope.can(dataset.area)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
    const result = await runReport(scope.dataId, report.spec, { dataset });
    return NextResponse.json({ report, result });
  } catch (err) {
    return reportsError(err, "reports.saved.id.run.POST");
  }
}
