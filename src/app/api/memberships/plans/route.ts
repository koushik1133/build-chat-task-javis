import { NextResponse, type NextRequest } from "next/server";
import { requireScope } from "@/lib/auth/scope";
import { parseBody } from "@/lib/money/http";
import { planGate } from "@/lib/plans/http";
import { memberErrorResponse } from "@/lib/memberships/http";
import { PlanInputSchema, createPlan, listPlans, orgSlugFor } from "@/lib/memberships/plans";
import { recordAudit } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/memberships/plans — all plans (archived too) with live member counts. */
export async function GET() {
  try {
    const scope = await requireScope({ area: "billing", edit: false });
    const [plans, org_slug] = await Promise.all([listPlans(scope.dataId, { includeInactive: true }), orgSlugFor(scope.dataId)]);
    return NextResponse.json({ plans, org_slug });
  } catch (err) {
    return memberErrorResponse(err, "memberships.plans.GET");
  }
}

/** POST /api/memberships/plans — create a plan (Starter and up). */
export async function POST(req: NextRequest) {
  try {
    const scope = await requireScope({ area: "billing", edit: true });
    const gate = await planGate(scope, { feature: "memberships" });
    if (gate) return gate;
    const body = await parseBody(req, PlanInputSchema);
    if (!body.ok) return body.res;
    const plan = await createPlan(scope.dataId, body.data);
    await recordAudit(scope, { action: "membership_plan.create", entity: "membership_plan", entityId: plan.id, after: { slug: plan.slug, name: plan.name }, req });
    return NextResponse.json({ plan }, { status: 201 });
  } catch (err) {
    return memberErrorResponse(err, "memberships.plans.POST");
  }
}
