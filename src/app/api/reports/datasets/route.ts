import { NextResponse } from "next/server";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { listDatasets } from "@/lib/reports/query";
import { AGGREGATIONS, DATE_BUCKETS } from "@/lib/reports/datasets";
import { DATE_PRESETS, FILTER_OPS } from "@/lib/reports/spec";
import { reportsError } from "@/lib/reports/http";

export const runtime = "nodejs";

/** GET /api/reports/datasets — catalogue of datasets the caller may report on (area-gated, table-probed). */
export async function GET() {
  let scope;
  try {
    scope = await requireScope({ area: "reports" });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const datasets = await listDatasets(scope.dataId, (area) => scope.can(area));
    return NextResponse.json({ datasets, aggregations: AGGREGATIONS, buckets: DATE_BUCKETS, ops: FILTER_OPS, presets: DATE_PRESETS });
  } catch (err) {
    return reportsError(err, "reports.datasets.GET");
  }
}
