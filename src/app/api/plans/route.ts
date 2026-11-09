import { NextResponse } from "next/server";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { listPlans } from "@/lib/plans/catalog";
import { buildPlanSummary } from "@/lib/plans/entitlements";
import { getSubscription, toSubscriptionDTO } from "@/lib/plans/subscription";
import { getOrgSettings } from "@/lib/org-settings";
import { planErrorResponse } from "@/lib/plans/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/plans — catalog plus the caller's plan, subscription and usage. */
export async function GET() {
  let scope;
  try {
    scope = await requireScope();
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const settings = await getOrgSettings(scope.dataId).catch(() => null);
    const [summary, sub] = await Promise.all([buildPlanSummary(scope.dataId), getSubscription(scope.dataId)]);
    return NextResponse.json({
      plans: listPlans(),
      subscription: toSubscriptionDTO(sub),
      entitlements: summary.entitlements,
      usage: summary.usage,
      enforced: summary.enforced,
      currency: settings?.currency ?? "USD",
      canManage: scope.role === "owner" || scope.role === "admin",
    });
  } catch (err) {
    return planErrorResponse(err, "plans.GET");
  }
}
