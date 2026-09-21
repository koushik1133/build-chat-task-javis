import { createHash, randomBytes, randomUUID } from "crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { query, queryOne } from "@/lib/dsql";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { ROLES, canManageRole } from "@/lib/auth/roles";
import { rateLimit } from "@/lib/request-limits";

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

  const limit = rateLimit(`team-invite:${scope.userId}`, 20, 60 * 60 * 1000);
  if (!limit.allowed) return NextResponse.json({ error: "rate limited" }, { status: 429 });

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad request" }, { status: 400 });
  const email = parsed.data.email.trim().toLowerCase();
  const role = parsed.data.role;

  if (role === "owner" || !canManageRole(scope.role, role)) {
    return NextResponse.json({ error: "forbidden", detail: "You cannot assign that role." }, { status: 403 });
  }

  const existing = await queryOne<{ id: string; status: string }>(
    `SELECT id, status FROM memberships
      WHERE org_id = $1 AND LOWER(invited_email) = $2 AND status IN ('active', 'invited')
      LIMIT 1`,
    [scope.orgId, email]
  ).catch(() => null);
  if (existing?.status === "active") {
    return NextResponse.json({ error: "already a member" }, { status: 409 });
  }

  const token = randomBytes(32).toString("hex");
  const tokenHash = createHash("sha256").update(token).digest("hex");

  if (existing?.status === "invited") {
    // Re-issue: replace the old token and refresh the expiry window.
    await query(
      `UPDATE memberships SET role = $1, invite_token_hash = $2, invited_by = $3, created_at = NOW(), updated_at = NOW()
        WHERE id = $4`,
      [role, tokenHash, scope.userId, existing.id]
    );
  } else {
    await query(
      `INSERT INTO memberships (id, org_id, user_id, role, status, invited_email, invite_token_hash, invited_by)
       VALUES ($1, $2, NULL, $3, 'invited', $4, $5, $6)`,
      [randomUUID(), scope.orgId, role, email, tokenHash, scope.userId]
    );
  }

  const origin = new URL(req.url).origin;
  return NextResponse.json({ inviteUrl: `${origin}/invite/${token}`, email, role });
}
