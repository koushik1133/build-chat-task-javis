import { NextResponse } from "next/server";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { buildPlanSummary } from "@/lib/plans/entitlements";
import { planErrorResponse } from "@/lib/plans/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/plans/usage — limits, features and measured usage (any member; powers useEntitlement). */
export async function GET() {
  let scope;
  try {
    scope = await requireScope();
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const s = await buildPlanSummary(scope.dataId);
    return NextResponse.json({ plan: s.entitlements.plan, status: s.entitlements.status, limits: s.entitlements.limits, features: s.entitlements.features, trial: s.entitlements.trial, usage: s.usage, enforced: s.enforced, upgrade_hints: s.upgrade_hints });
  } catch (err) {
    return planErrorResponse(err, "plans.usage.GET");
  }
}
