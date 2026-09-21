import { NextResponse } from "next/server";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { queryOne, query } from "@/lib/dsql";

export const runtime = "nodejs";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  let scope;
  try {
    scope = await requireScope({ area: "sites", edit: false });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { id } = await ctx.params;
  const site = await queryOne(
    `SELECT id, title, persona, plan, html, updated_at
     FROM sites
     WHERE id = $1 AND user_id = $2`,
    [id, scope.dataId]
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
  let scope;
  try {
    scope = await requireScope({ area: "sites", edit: true });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await ctx.params;
  await query("DELETE FROM sites WHERE id = $1 AND user_id = $2", [id, scope.dataId]);
  return NextResponse.json({ ok: true });
}
