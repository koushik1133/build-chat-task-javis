import { NextResponse, type NextRequest } from "next/server";
import { recordAudit } from "@/lib/audit";
import { parseBody } from "@/lib/money/http";
import { paramId, workforceError, workforceScope } from "@/lib/workforce/http";
import { decideSwap, SwapDecisionSchema } from "@/lib/workforce/shifts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** PATCH /api/workforce/shifts/swaps/[id] {decision: approve|reject} */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = await workforceScope(req, true);
  if (!s.ok) return s.res;
  const parsed = await parseBody(req, SwapDecisionSchema, 2_048);
  if (!parsed.ok) return parsed.res;
  try {
    const id = await paramId(ctx);
    const swap = await decideSwap(s.scope.dataId, id, parsed.data.decision);
    void recordAudit(s.scope, { action: `swap_${parsed.data.decision}`, entity: "shift_swap", entityId: id, req }).catch(() => undefined);
    return NextResponse.json({ swap });
  } catch (err) {
    return workforceError(err, "workforce.swap.decide");
  }
}
