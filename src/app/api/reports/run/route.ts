import { NextResponse, type NextRequest } from "next/server";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { rateLimitAsync } from "@/lib/request-limits";
import { resolveDataset, runReport } from "@/lib/reports/query";
import { ReportSpecSchema } from "@/lib/reports/spec";
import { parseJson, reportsError } from "@/lib/reports/http";

export const runtime = "nodejs";

/** POST /api/reports/run — run an ad-hoc spec. The dataset's area must be viewable by the caller. */
export async function POST(req: NextRequest) {
  let scope;
  try {
    scope = await requireScope({ area: "reports" });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const rl = await rateLimitAsync(`reports:run:${scope.dataId}`, 60, 60_000);
  if (!rl.allowed) return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: { "Retry-After": String(Math.max(1, Math.ceil((rl.resetAt - Date.now()) / 1000))) } });
  const body = await parseJson(req, ReportSpecSchema);
  if (!body.ok) return body.res;
  try {
    const dataset = await resolveDataset(scope.dataId, body.data.dataset);
    if (!dataset) return NextResponse.json({ error: "dataset_unavailable" }, { status: 404 });
    if (!scope.can(dataset.area)) return NextResponse.json({ error: "forbidden", detail: `Your role cannot view ${dataset.area}.` }, { status: 403 });
    const result = await runReport(scope.dataId, body.data, { dataset });
    return NextResponse.json({ result });
  } catch (err) {
    return reportsError(err, "reports.run.POST");
  }
}
