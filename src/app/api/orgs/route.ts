import { NextResponse } from "next/server";
import { listUserOrgs, requireScope, scopeErrorResponse } from "@/lib/auth/scope";

/** GET /api/orgs — workspaces the caller belongs to plus the active one. */
export async function GET() {
  let scope;
  try {
    scope = await requireScope();
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const rows = await listUserOrgs(scope.userId).catch(() => []);
  const orgs = rows.map((o) => ({ id: o.id, name: o.name, slug: o.slug, role: o.role, isOwner: o.owner_user_id === scope.userId }));
  return NextResponse.json({ orgs, activeOrgId: scope.orgId });
}
