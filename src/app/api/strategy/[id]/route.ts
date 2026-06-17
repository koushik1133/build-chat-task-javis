import { NextResponse } from "next/server";
import { requireUser } from "@/lib/supabase/server";
import { query, queryOne } from "@/lib/dsql";
import { parseProductionTasks } from "@/lib/strategy";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  let user;
  try { ({ user } = await requireUser()); }
  catch { return NextResponse.json({ error: "unauthorized" }, { status: 401 }); }

  const { id } = await ctx.params;
  const proposal = await queryOne(
    "SELECT * FROM strategies WHERE id = $1 AND user_id = $2",
    [id, user.id]
  ).catch(() => null);

  if (!proposal) return NextResponse.json({ error: "not found" }, { status: 404 });

  const tasks = parseProductionTasks((proposal as { content: string }).content);
  return NextResponse.json({ proposal, suggested_tasks: tasks });
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  let user;
  try { ({ user } = await requireUser()); }
  catch { return NextResponse.json({ error: "unauthorized" }, { status: 401 }); }

  const { id } = await ctx.params;
  const { status, content, title } = await req.json();

  if (title?.trim()) {
    await query("UPDATE strategies SET title = $1 WHERE id = $2 AND user_id = $3", [title.trim(), id, user.id]);
  }
  if (status) {
    await query("UPDATE strategies SET status = $1 WHERE id = $2 AND user_id = $3", [status, id, user.id]);
  }
  if (content !== undefined) {
    await query("UPDATE strategies SET content = $1 WHERE id = $2 AND user_id = $3", [content, id, user.id]);
    await query(
      "INSERT INTO strategy_versions (strategy_id, user_id, content) VALUES ($1, $2, $3)",
      [id, user.id, content]
    ).catch(() => {});
  }

  const proposal = await queryOne("SELECT * FROM strategies WHERE id = $1 AND user_id = $2", [id, user.id]);
  return NextResponse.json({ ok: true, proposal });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  let user;
  try { ({ user } = await requireUser()); }
  catch { return NextResponse.json({ error: "unauthorized" }, { status: 401 }); }

  const { id } = await ctx.params;
  await query("DELETE FROM strategy_versions WHERE strategy_id = $1 AND user_id = $2", [id, user.id]).catch(() => {});
  await query("DELETE FROM strategies WHERE id = $1 AND user_id = $2", [id, user.id]);
  return NextResponse.json({ ok: true });
}
