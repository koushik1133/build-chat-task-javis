import { NextResponse, type NextRequest } from "next/server";
import { recordAudit } from "@/lib/audit";
import { parseBody } from "@/lib/money/http";
import { paramId, workforceError, workforceScope } from "@/lib/workforce/http";
import { decideLeave, getLeave, LeaveDecisionSchema } from "@/lib/workforce/leave";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  const s = await workforceScope(req, false);
  if (!s.ok) return s.res;
  try {
    const leave = await getLeave(s.scope.dataId, await paramId(ctx));
    if (!leave) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ leave });
  } catch (err) {
    return workforceError(err, "workforce.leave.get");
  }
}

/** PATCH /api/workforce/leave/[id] {decision: approve|reject|cancel, note?} */
export async function PATCH(req: NextRequest, ctx: Ctx) {
  const s = await workforceScope(req, true);
  if (!s.ok) return s.res;
  const parsed = await parseBody(req, LeaveDecisionSchema, 4_096);
  if (!parsed.ok) return parsed.res;
  try {
    const id = await paramId(ctx);
    const leave = await decideLeave(s.scope.dataId, id, parsed.data.decision, s.scope.userId, parsed.data.note ?? null);
    void recordAudit(s.scope, { action: `leave_${parsed.data.decision}`, entity: "leave_request", entityId: id, req }).catch(() => undefined);
    return NextResponse.json({ leave });
  } catch (err) {
    return workforceError(err, "workforce.leave.decide");
  }
}
