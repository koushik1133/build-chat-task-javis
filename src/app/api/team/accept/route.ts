import { createHash } from "crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/supabase/server";
import { query, queryOne } from "@/lib/dsql";
import { ORG_COOKIE } from "@/lib/auth/scope";

const Body = z.object({ token: z.string().regex(/^[a-f0-9]{64}$/) });
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface InviteRow { id: string; org_id: string; role: string; created_at: string }

/** POST /api/team/accept — redeem an invite token for the signed-in user. */
export async function POST(req: Request) {
  let user;
  try {
    ({ user } = await requireUser());
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad request" }, { status: 400 });

  const tokenHash = createHash("sha256").update(parsed.data.token).digest("hex");
  const invite = await queryOne<InviteRow>(
    `SELECT id, org_id, role, created_at FROM memberships WHERE invite_token_hash = $1 AND status = 'invited'`,
    [tokenHash]
  ).catch(() => null);
  if (!invite) return NextResponse.json({ error: "invalid or used invite" }, { status: 404 });
  if (Date.now() - new Date(invite.created_at).getTime() > INVITE_TTL_MS) {
    return NextResponse.json({ error: "invite expired" }, { status: 410 });
  }

  const already = await queryOne<{ id: string }>(
    `SELECT id FROM memberships WHERE org_id = $1 AND user_id = $2 AND status = 'active'`,
    [invite.org_id, user.id]
  ).catch(() => null);
  if (already) return NextResponse.json({ error: "already a member", orgId: invite.org_id }, { status: 409 });

  await query(
    `UPDATE memberships
        SET user_id = $1, status = 'active', accepted_at = NOW(), invite_token_hash = NULL,
            invited_email = COALESCE(invited_email, $2), updated_at = NOW()
      WHERE id = $3`,
    [user.id, user.email ?? null, invite.id]
  );

  const res = NextResponse.json({ ok: true, orgId: invite.org_id, role: invite.role });
  res.cookies.set(ORG_COOKIE, invite.org_id, {
    httpOnly: true,
    path: "/",
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 60 * 60 * 24 * 365,
  });
  return res;
}
