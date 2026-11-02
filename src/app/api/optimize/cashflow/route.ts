import { NextResponse, type NextRequest } from "next/server";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { dbUnavailableResponse } from "@/lib/api-db";
import { runCashflow } from "@/lib/optimize";
import { intParam, respondWithNarrative, wantsNarrative } from "@/lib/optimize/http";

export const dynamic = "force-dynamic";

/** GET /api/optimize/cashflow?weeks=12&opening=<minor>&narrate=1 */
export async function GET(req: NextRequest) {
  let scope;
  try {
    scope = await requireScope({ area: "reports" });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const sp = req.nextUrl.searchParams;
  const weeks = intParam(sp, "weeks", 12, 1, 52);
  const opening = intParam(sp, "opening", 0, -1_000_000_000_000, 1_000_000_000_000);
  try {
    const forecast = await runCashflow(scope.dataId, { weeks, openingBalance: opening });
    return respondWithNarrative(scope.dataId, "cashflow", "forecast", forecast, wantsNarrative(sp));
  } catch (err) {
    return dbUnavailableResponse(err, "optimize/cashflow");
  }
}
