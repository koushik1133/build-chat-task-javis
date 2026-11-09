import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { recordAudit } from "@/lib/audit";
import { parseBody } from "@/lib/money/http";
import { changeSeats } from "@/lib/plans/checkout";
import { planAdminScope, planErrorResponse } from "@/lib/plans/http";

export const runtime = "nodejs";

const Body = z.object({ seats: z.number().int().min(1).max(1000) }).strict();

/** PATCH /api/plans/seats — increases are charged pro rata now, decreases apply at renewal. */
export async function PATCH(req: NextRequest) {
  const a = await planAdminScope();
  if (!a.ok) return a.res;
  const body = await parseBody(req, Body, 1_024);
  if (!body.ok) return body.res;
  try {
    const out = await changeSeats(a.scope.dataId, body.data.seats);
    void recordAudit(a.scope, { action: "plan.seats", entity: "subscription", entityId: a.scope.dataId, after: { seats: body.data.seats }, req }).catch(() => undefined);
    return NextResponse.json(out);
  } catch (err) {
    return planErrorResponse(err, "plans.seats.PATCH");
  }
}
