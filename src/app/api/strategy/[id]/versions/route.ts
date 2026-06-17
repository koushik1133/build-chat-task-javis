import { NextResponse } from "next/server";
import { requireUser } from "@/lib/supabase/server";
import { query, queryOne } from "@/lib/dsql";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  let user;
  try { ({ user } = await requireUser()); }
  catch { return NextResponse.json({ error: "unauthorized" }, { status: 401 }); }

  const { id } = await ctx.params;
  const versions = await query(
    `SELECT id, created_at FROM strategy_versions
     WHERE strategy_id = $1 AND user_id = $2
     ORDER BY created_at DESC LIMIT 20`,
    [id, user.id]
  ).catch(() => []);

  return NextResponse.json({ versions });
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  let user;
  try { ({ user } = await requireUser()); }
  catch { return NextResponse.json({ error: "unauthorized" }, { status: 401 }); }

  const { id } = await ctx.params;
  const { version_id } = await req.json().catch(() => ({}));

  const version = await queryOne<{ content: string }>(
    version_id
      ? "SELECT content FROM strategy_versions WHERE id = $1 AND strategy_id = $2 AND user_id = $3"
      : "SELECT content FROM strategy_versions WHERE strategy_id = $1 AND user_id = $2 ORDER BY created_at DESC LIMIT 1",
    version_id ? [version_id, id, user.id] : [id, user.id]
  ).catch(() => null);

  if (!version) return NextResponse.json({ error: "version not found" }, { status: 404 });

  await query("UPDATE strategies SET content = $1 WHERE id = $2 AND user_id = $3", [version.content, id, user.id]);
  const proposal = await queryOne("SELECT * FROM strategies WHERE id = $1 AND user_id = $2", [id, user.id]);
  return NextResponse.json({ proposal });
}
