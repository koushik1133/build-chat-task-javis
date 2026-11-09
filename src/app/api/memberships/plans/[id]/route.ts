import { NextResponse, type NextRequest } from "next/server";
import { requireScope } from "@/lib/auth/scope";
import { parseBody } from "@/lib/money/http";
import { memberErrorResponse } from "@/lib/memberships/http";
import { PlanPatchSchema, archivePlan, getPlan, updatePlan } from "@/lib/memberships/plans";
import { recordAudit } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, ctx: Ctx) {
  try {
    const scope = await requireScope({ area: "billing", edit: false });
    const { id } = await ctx.params;
    const plan = await getPlan(scope.dataId, id);
    return plan ? NextResponse.json({ plan }) : NextResponse.json({ error: "not_found" }, { status: 404 });
  } catch (err) {
    return memberErrorResponse(err, "memberships.plan.GET");
  }
}

export async function PATCH(req: NextRequest, ctx: Ctx) {
  try {
    const scope = await requireScope({ area: "billing", edit: true });
    const { id } = await ctx.params;
    const body = await parseBody(req, PlanPatchSchema);
    if (!body.ok) return body.res;
    const plan = await updatePlan(scope.dataId, id, body.data);
    await recordAudit(scope, { action: "membership_plan.update", entity: "membership_plan", entityId: id, after: body.data as Record<string, unknown>, req });
    return NextResponse.json({ plan });
  } catch (err) {
    return memberErrorResponse(err, "memberships.plan.PATCH");
  }
}

/** DELETE archives: existing subscribers keep their plan, new sign-ups stop. */
export async function DELETE(req: NextRequest, ctx: Ctx) {
  try {
    const scope = await requireScope({ area: "billing", edit: true });
    const { id } = await ctx.params;
    const plan = await archivePlan(scope.dataId, id);
    await recordAudit(scope, { action: "membership_plan.archive", entity: "membership_plan", entityId: id, req });
    return NextResponse.json({ plan });
  } catch (err) {
    return memberErrorResponse(err, "memberships.plan.DELETE");
  }
}
