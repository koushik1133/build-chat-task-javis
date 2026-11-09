import { NextResponse, type NextRequest } from "next/server";
import { recordAudit } from "@/lib/audit";
import { parseBody } from "@/lib/money/http";
import { paramId, workforceError, workforceScope } from "@/lib/workforce/http";
import { deleteShift, getShift, ShiftPatchSchema, updateShift } from "@/lib/workforce/shifts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  const s = await workforceScope(req, false);
  if (!s.ok) return s.res;
  try {
    const shift = await getShift(s.scope.dataId, await paramId(ctx));
    if (!shift) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ shift });
  } catch (err) {
    return workforceError(err, "workforce.shift.get");
  }
}

export async function PATCH(req: NextRequest, ctx: Ctx) {
  const s = await workforceScope(req, true);
  if (!s.ok) return s.res;
  const parsed = await parseBody(req, ShiftPatchSchema, 16_384);
  if (!parsed.ok) return parsed.res;
  try {
    const id = await paramId(ctx);
    const shift = await updateShift(s.scope.dataId, id, parsed.data);
    void recordAudit(s.scope, { action: "update", entity: "shift", entityId: id, after: parsed.data as Record<string, unknown>, req }).catch(() => undefined);
    return NextResponse.json({ shift });
  } catch (err) {
    return workforceError(err, "workforce.shift.patch");
  }
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  const s = await workforceScope(req, true);
  if (!s.ok) return s.res;
  try {
    const id = await paramId(ctx);
    const r = await deleteShift(s.scope.dataId, id);
    if (!r.deleted && !r.cancelled) return NextResponse.json({ error: "not_found" }, { status: 404 });
    void recordAudit(s.scope, { action: r.deleted ? "delete" : "cancel", entity: "shift", entityId: id, req }).catch(() => undefined);
    return NextResponse.json({ ok: true, ...r });
  } catch (err) {
    return workforceError(err, "workforce.shift.delete");
  }
}
