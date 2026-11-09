import { NextResponse, type NextRequest } from "next/server";
import { recordAudit } from "@/lib/audit";
import { planAdminScope, planErrorResponse } from "@/lib/plans/http";
import { resumeSubscription, toSubscriptionDTO } from "@/lib/plans/subscription";

export const runtime = "nodejs";

/** POST /api/plans/resume — undo a scheduled cancellation. */
export async function POST(req: NextRequest) {
  const a = await planAdminScope();
  if (!a.ok) return a.res;
  try {
    const sub = await resumeSubscription(a.scope.dataId);
    void recordAudit(a.scope, { action: "plan.resume", entity: "subscription", entityId: a.scope.dataId, req }).catch(() => undefined);
    return NextResponse.json({ subscription: toSubscriptionDTO(sub) });
  } catch (err) {
    return planErrorResponse(err, "plans.resume.POST");
  }
}
