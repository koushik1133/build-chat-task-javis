import { NextResponse, type NextRequest } from "next/server";
import { recordAudit } from "@/lib/audit";
import { parseBody } from "@/lib/money/http";
import { paramId, workforceError, workforceScope } from "@/lib/workforce/http";
import { requestSwap, SwapRequestSchema } from "@/lib/workforce/shifts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/workforce/shifts/[id]/swap {to_staff_id, note?} — request a swap. */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = await workforceScope(req, true);
  if (!s.ok) return s.res;
  const parsed = await parseBody(req, SwapRequestSchema, 8_192);
  if (!parsed.ok) return parsed.res;
  try {
    const swap = await requestSwap(s.scope.dataId, await paramId(ctx), parsed.data);
    void recordAudit(s.scope, { action: "swap_request", entity: "shift", entityId: swap.shift_id, after: { to_staff_id: swap.to_staff_id }, req }).catch(() => undefined);
    return NextResponse.json({ swap }, { status: 201 });
  } catch (err) {
    return workforceError(err, "workforce.swap.request");
  }
}
