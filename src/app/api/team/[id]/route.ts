import { NextResponse } from "next/server";
import { z } from "zod";
import { query, queryOne } from "@/lib/dsql";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { ROLES, canManageRole, isRole } from "@/lib/auth/roles";

type Ctx = { params: Promise<{ id: string }> };

interface MembershipRow { id: string; user_id: string | null; role: string; status: string }

async function loadTarget(orgId: string, id: string): Promise<MembershipRow | null> {
  return queryOne<MembershipRow>(
    `SELECT id, user_id, role, status FROM memberships WHERE id = $1 AND org_id = $2 AND status IN ('active', 'invited')`,
    [id, orgId]
  ).catch(() => null);
}

const Patch = z.object({ role: z.enum(ROLES) });

/** PATCH /api/team/:id — change a member's role. */
export async function PATCH(req: Request, { params }: Ctx) {
  let scope;
  try {
    scope = await requireScope({ area: "team", edit: true });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const parsed = Patch.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad request" }, { status: 400 });
  const nextRole = parsed.data.role;

  const target = await loadTarget(scope.orgId, id);
  if (!target) return NextResponse.json({ error: "not found" }, { status: 404 });

  const currentRole = isRole(target.role) ? target.role : "viewer";
  if (currentRole === "owner" || nextRole === "owner") {
    return NextResponse.json({ error: "forbidden", detail: "The workspace owner cannot be changed." }, { status: 403 });
  }
  if (!canManageRole(scope.role, currentRole) || !canManageRole(scope.role, nextRole)) {
    return NextResponse.json({ error: "forbidden", detail: "You cannot act above your own role." }, { status: 403 });
  }

  await query(`UPDATE memberships SET role = $1, updated_at = NOW() WHERE id = $2`, [nextRole, id]);
  return NextResponse.json({ ok: true, id, role: nextRole });
}

/** DELETE /api/team/:id — remove a member or revoke a pending invite. */
export async function DELETE(_req: Request, { params }: Ctx) {
  let scope;
  try {
    scope = await requireScope({ area: "team", edit: true });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const target = await loadTarget(scope.orgId, id);
  if (!target) return NextResponse.json({ error: "not found" }, { status: 404 });

  const currentRole = isRole(target.role) ? target.role : "viewer";
  if (currentRole === "owner") {
    return NextResponse.json({ error: "forbidden", detail: "The workspace owner cannot be removed." }, { status: 403 });
  }
  if (!canManageRole(scope.role, currentRole)) {
    return NextResponse.json({ error: "forbidden", detail: "You cannot act above your own role." }, { status: 403 });
  }

  await query(
    `UPDATE memberships SET status = 'removed', invite_token_hash = NULL, updated_at = NOW() WHERE id = $1`,
    [id]
  );
  return NextResponse.json({ ok: true, id });
}
