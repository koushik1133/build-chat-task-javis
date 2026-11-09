import { NextResponse } from "next/server";
import { z } from "zod";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { ROLES, canManageRole } from "@/lib/auth/roles";
import { rateLimitAsync } from "@/lib/request-limits";
import { AlreadyMemberError, createInvite } from "@/lib/team";

const Body = z.object({
  email: z.string().email().max(254),
  role: z.enum(ROLES),
});

/** POST /api/team/invite — create a pending membership and return a one-time invite link. */
export async function POST(req: Request) {
  let scope;
  try {
    scope = await requireScope({ area: "team", edit: true });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const limit = await rateLimitAsync(`team-invite:${scope.userId}`, 20, 60 * 60 * 1000);
  if (!limit.allowed) return NextResponse.json({ error: "rate limited" }, { status: 429 });

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad request" }, { status: 400 });
  const email = parsed.data.email.trim().toLowerCase();
  const role = parsed.data.role;

  if (role === "owner" || !canManageRole(scope.role, role)) {
    return NextResponse.json({ error: "forbidden", detail: "You cannot assign that role." }, { status: 403 });
  }

  try {
    const invite = await createInvite(scope.orgId, { email, role, invitedBy: scope.userId, origin: new URL(req.url).origin });
    return NextResponse.json({ inviteUrl: invite.inviteUrl, email, role });
  } catch (err) {
    if (err instanceof AlreadyMemberError) return NextResponse.json({ error: "already a member" }, { status: 409 });
    console.error("[team/invite] failed:", err);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
