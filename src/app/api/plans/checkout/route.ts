import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { recordAudit } from "@/lib/audit";
import { parseBody } from "@/lib/money/http";
import { rateLimitAsync } from "@/lib/request-limits";
import { startPlanCheckout } from "@/lib/plans/checkout";
import { planAdminScope, planErrorResponse } from "@/lib/plans/http";

export const runtime = "nodejs";

const Body = z.object({ plan_key: z.string().max(40), interval: z.enum(["month", "year"]), seats: z.number().int().min(1).max(1000).optional() }).strict();

/** POST /api/plans/checkout — buy or change a plan (upgrades charge pro rata now; downgrades apply at renewal). */
export async function POST(req: NextRequest) {
  const a = await planAdminScope();
  if (!a.ok) return a.res;
  const limit = await rateLimitAsync(`plan-checkout:${a.scope.userId}`, 20, 60 * 60 * 1000);
  if (!limit.allowed) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  const body = await parseBody(req, Body, 2_048);
  if (!body.ok) return body.res;
  try {
    const out = await startPlanCheckout(a.scope.dataId, { planKey: body.data.plan_key, interval: body.data.interval, seats: body.data.seats });
    void recordAudit(a.scope, { action: "plan.checkout", entity: "subscription", entityId: a.scope.dataId, after: { plan: body.data.plan_key, interval: body.data.interval, scheduled: out.scheduled }, req }).catch(() => undefined);
    return NextResponse.json(out);
  } catch (err) {
    return planErrorResponse(err, "plans.checkout.POST");
  }
}
