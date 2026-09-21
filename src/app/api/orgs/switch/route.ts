import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/supabase/server";
import { queryOne } from "@/lib/dsql";
import { ORG_COOKIE } from "@/lib/auth/scope";

const Body = z.object({ orgId: z.string().min(1).max(64) });

/** POST /api/orgs/switch — set the active workspace cookie after checking membership. */
export async function POST(req: Request) {
  let user;
  try {
    ({ user } = await requireUser());
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad request" }, { status: 400 });

  const membership = await queryOne<{ org_id: string }>(
    `SELECT org_id FROM memberships WHERE user_id = $1 AND org_id = $2 AND status = 'active'`,
    [user.id, parsed.data.orgId]
  ).catch(() => null);
  if (!membership) return NextResponse.json({ error: "not a member" }, { status: 403 });

  const res = NextResponse.json({ ok: true, activeOrgId: membership.org_id });
  res.cookies.set(ORG_COOKIE, membership.org_id, {
    httpOnly: true,
    path: "/",
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 60 * 60 * 24 * 365,
  });
  return res;
}
