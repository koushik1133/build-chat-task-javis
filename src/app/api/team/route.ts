import { NextResponse } from "next/server";
import { query } from "@/lib/dsql";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";

export interface TeamMemberRow {
  id: string;
  user_id: string | null;
  role: string;
  status: string;
  invited_email: string | null;
  invited_by: string | null;
  created_at: string;
  accepted_at: string | null;
}

/** GET /api/team — active members and pending invites for the active workspace. */
export async function GET() {
  let scope;
  try {
    scope = await requireScope({ area: "team" });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const rows = await query<TeamMemberRow>(
    `SELECT id, user_id, role, status, invited_email, invited_by, created_at, accepted_at
       FROM memberships
      WHERE org_id = $1 AND status IN ('active', 'invited')
      ORDER BY (role = 'owner') DESC, created_at ASC`,
    [scope.orgId]
  ).catch(() => []);

  const sevenDays = 7 * 24 * 60 * 60 * 1000;
  const now = Date.now();
  const members = rows
    .filter((r) => r.status === "active")
    .map((r) => ({
      id: r.id,
      userId: r.user_id,
      email: r.invited_email,
      role: r.role,
      isOwner: r.role === "owner",
      isSelf: r.user_id === scope.userId,
      joinedAt: r.accepted_at ?? r.created_at,
    }));
  const invites = rows
    .filter((r) => r.status === "invited")
    .map((r) => ({
      id: r.id,
      email: r.invited_email,
      role: r.role,
      createdAt: r.created_at,
      expired: now - new Date(r.created_at).getTime() > sevenDays,
    }));

  return NextResponse.json({ orgId: scope.orgId, role: scope.role, members, invites });
}
