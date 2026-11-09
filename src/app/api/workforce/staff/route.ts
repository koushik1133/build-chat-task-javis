import { NextResponse, type NextRequest } from "next/server";
import { recordAudit } from "@/lib/audit";
import { parseBody } from "@/lib/money/http";
import { workforceError, workforceScope } from "@/lib/workforce/http";
import { createStaff, listStaff, StaffInputSchema } from "@/lib/workforce/staff";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/workforce/staff?all=1 — staff profiles (active by default). */
export async function GET(req: NextRequest) {
  const s = await workforceScope(req, false);
  if (!s.ok) return s.res;
  try {
    const staff = await listStaff(s.scope.dataId, { includeInactive: req.nextUrl.searchParams.get("all") === "1" });
    return NextResponse.json({ staff });
  } catch (err) {
    return workforceError(err, "workforce.staff.list");
  }
}

/** POST /api/workforce/staff — create a profile. */
export async function POST(req: NextRequest) {
  const s = await workforceScope(req, true);
  if (!s.ok) return s.res;
  const parsed = await parseBody(req, StaffInputSchema, 16_384);
  if (!parsed.ok) return parsed.res;
  try {
    const staff = await createStaff(s.scope.dataId, parsed.data);
    void recordAudit(s.scope, { action: "create", entity: "staff_profile", entityId: staff.id, after: { display_name: staff.display_name, role_title: staff.role_title }, req }).catch(() => undefined);
    return NextResponse.json({ staff }, { status: 201 });
  } catch (err) {
    return workforceError(err, "workforce.staff.create");
  }
}
