import { NextResponse, type NextRequest } from "next/server";
import { recordAudit } from "@/lib/audit";
import { parseBody } from "@/lib/money/http";
import { paramId, workforceError, workforceScope } from "@/lib/workforce/http";
import { deactivateStaff, getStaff, StaffPatchSchema, updateStaff } from "@/lib/workforce/staff";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  const s = await workforceScope(req, false);
  if (!s.ok) return s.res;
  try {
    const staff = await getStaff(s.scope.dataId, await paramId(ctx));
    if (!staff) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ staff });
  } catch (err) {
    return workforceError(err, "workforce.staff.get");
  }
}

export async function PATCH(req: NextRequest, ctx: Ctx) {
  const s = await workforceScope(req, true);
  if (!s.ok) return s.res;
  const parsed = await parseBody(req, StaffPatchSchema, 16_384);
  if (!parsed.ok) return parsed.res;
  try {
    const id = await paramId(ctx);
    const staff = await updateStaff(s.scope.dataId, id, parsed.data);
    void recordAudit(s.scope, { action: "update", entity: "staff_profile", entityId: id, after: parsed.data as Record<string, unknown>, req }).catch(() => undefined);
    return NextResponse.json({ staff });
  } catch (err) {
    return workforceError(err, "workforce.staff.patch");
  }
}

/** DELETE — deactivates (history is kept). */
export async function DELETE(req: NextRequest, ctx: Ctx) {
  const s = await workforceScope(req, true);
  if (!s.ok) return s.res;
  try {
    const id = await paramId(ctx);
    const ok = await deactivateStaff(s.scope.dataId, id);
    if (!ok) return NextResponse.json({ error: "not_found" }, { status: 404 });
    void recordAudit(s.scope, { action: "deactivate", entity: "staff_profile", entityId: id, req }).catch(() => undefined);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return workforceError(err, "workforce.staff.delete");
  }
}
