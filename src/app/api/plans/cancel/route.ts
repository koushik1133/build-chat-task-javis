import { NextResponse, type NextRequest } from "next/server";
import { recordAudit } from "@/lib/audit";
import { planAdminScope, planErrorResponse } from "@/lib/plans/http";
import { cancelAtPeriodEnd, toSubscriptionDTO } from "@/lib/plans/subscription";

export const runtime = "nodejs";

/** POST /api/plans/cancel — cancel at the end of the paid period. */
export async function POST(req: NextRequest) {
  const a = await planAdminScope();
  if (!a.ok) return a.res;
  try {
    const sub = await cancelAtPeriodEnd(a.scope.dataId);
    void recordAudit(a.scope, { action: "plan.cancel", entity: "subscription", entityId: a.scope.dataId, req }).catch(() => undefined);
    return NextResponse.json({ subscription: toSubscriptionDTO(sub) });
  } catch (err) {
    return planErrorResponse(err, "plans.cancel.POST");
  }
}
