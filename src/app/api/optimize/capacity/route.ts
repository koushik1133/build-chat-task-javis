import { NextResponse, type NextRequest } from "next/server";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { dbUnavailableResponse } from "@/lib/api-db";
import { runCapacity } from "@/lib/optimize";
import { intParam, respondWithNarrative, wantsNarrative } from "@/lib/optimize/http";

export const dynamic = "force-dynamic";

/** GET /api/optimize/capacity?weeks=8&lookback=4&target=85&narrate=1 */
export async function GET(req: NextRequest) {
  let scope;
  try {
    scope = await requireScope({ area: "reports" });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const sp = req.nextUrl.searchParams;
  const weeks = intParam(sp, "weeks", 8, 1, 26);
  const lookbackWeeks = intParam(sp, "lookback", 4, 1, 12);
  const target = intParam(sp, "target", 85, 30, 100) / 100;
  try {
    const plan = await runCapacity(scope.dataId, { weeks, lookbackWeeks, target });
    return respondWithNarrative(scope.dataId, "capacity", "plan", plan, wantsNarrative(sp));
  } catch (err) {
    return dbUnavailableResponse(err, "optimize/capacity");
  }
}
