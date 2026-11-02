import { NextResponse, type NextRequest } from "next/server";
import { requireScope } from "@/lib/auth/scope";
import { dateParam, financeErrorResponse } from "@/lib/finance/http";
import { parseRef } from "@/lib/finance/expenses";
import { jobCosting, jobCostingSummary } from "@/lib/finance/job-costing";

export const runtime = "nodejs";

/** GET /api/reports/job-costing?from=&to=  |  ?ref=invoice:<id> for one job */
export async function GET(req: NextRequest) {
  try {
    const scope = await requireScope({ area: "reports" });
    const ref = parseRef(req.nextUrl.searchParams.get("ref"));
    const from = dateParam(req, "from");
    const to = dateParam(req, "to");
    const report = ref ? await jobCosting(scope.dataId, ref) : await jobCostingSummary(scope.dataId, { from, to });
    return NextResponse.json({ report, range: { from, to }, ref });
  } catch (err) {
    return financeErrorResponse(err, "reports.job-costing.GET");
  }
}
