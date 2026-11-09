import { NextResponse } from "next/server";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { getEntitlements } from "@/lib/plans/entitlements";
import { getSubscription, toSubscriptionDTO } from "@/lib/plans/subscription";
import { planErrorResponse } from "@/lib/plans/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  let scope;
  try {
    scope = await requireScope();
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const [sub, ent] = await Promise.all([getSubscription(scope.dataId), getEntitlements(scope.dataId)]);
    return NextResponse.json({ subscription: toSubscriptionDTO(sub), entitlements: ent });
  } catch (err) {
    return planErrorResponse(err, "plans.subscription.GET");
  }
}
