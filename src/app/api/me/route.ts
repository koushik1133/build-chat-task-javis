import { NextResponse } from "next/server";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";

/** GET /api/me — caller identity, active workspace, role and permission matrix (for UI gating). */
export async function GET() {
  let scope;
  try {
    scope = await requireScope();
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  return NextResponse.json({
    userId: scope.userId,
    email: scope.email,
    org: { id: scope.orgId, name: scope.orgName, slug: scope.orgSlug },
    role: scope.role,
    isOwner: scope.isOwner,
    permissions: scope.permissions,
  });
}
