import { NextResponse } from "next/server";
import { requireUser } from "@/lib/supabase/server";
import { queryOne, query } from "@/lib/dsql";

export const runtime = "nodejs";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  let user;
  try {
    ({ user } = await requireUser());
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { id } = await ctx.params;
  const site = await queryOne(
    `SELECT id, title, persona, plan, html, updated_at
     FROM sites
     WHERE id = $1 AND user_id = $2`,
    [id, user.id]
  );
  if (!site) return NextResponse.json({ error: "not found" }, { status: 404 });

  // plan is stored as TEXT in DSQL — parse it back to JSON
  return NextResponse.json({
    site: {
      ...site,
      plan: site.plan ? JSON.parse(site.plan as string) : null,
    },
  });
}

export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  let user;
  try {
    ({ user } = await requireUser());
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await ctx.params;
  await query("DELETE FROM sites WHERE id = $1 AND user_id = $2", [id, user.id]);
  return NextResponse.json({ ok: true });
}
