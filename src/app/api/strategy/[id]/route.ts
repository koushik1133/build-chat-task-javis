import { NextResponse } from "next/server";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { query, queryOne } from "@/lib/dsql";
import { parseProductionTasks } from "@/lib/strategy";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  let scope;
  try { scope = await requireScope({ area: "knowledge", edit: false }); }
  catch (err) { return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 }); }

  const { id } = await ctx.params;
  const proposal = await queryOne(
    "SELECT * FROM strategies WHERE id = $1 AND user_id = $2",
    [id, scope.dataId]
  ).catch(() => null);

  if (!proposal) return NextResponse.json({ error: "not found" }, { status: 404 });

  const tasks = parseProductionTasks((proposal as { content: string }).content);
  return NextResponse.json({ proposal, suggested_tasks: tasks });
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  let scope;
  try { scope = await requireScope({ area: "knowledge", edit: true }); }
  catch (err) { return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 }); }

  const { id } = await ctx.params;
  const rawBody = await req.json().catch(() => null);
  if (!rawBody || typeof rawBody !== "object") return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  const { status, content, title } = rawBody;

  if (title?.trim()) {
    await query("UPDATE strategies SET title = $1 WHERE id = $2 AND user_id = $3", [title.trim(), id, scope.dataId]);
  }
  if (status) {
    await query("UPDATE strategies SET status = $1 WHERE id = $2 AND user_id = $3", [status, id, scope.dataId]);
  }
  if (content !== undefined) {
    await query("UPDATE strategies SET content = $1 WHERE id = $2 AND user_id = $3", [content, id, scope.dataId]);
    await query(
      "INSERT INTO strategy_versions (strategy_id, user_id, content) VALUES ($1, $2, $3)",
      [id, scope.dataId, content]
    ).catch(() => {});
  }

  const proposal = await queryOne("SELECT * FROM strategies WHERE id = $1 AND user_id = $2", [id, scope.dataId]);
  return NextResponse.json({ ok: true, proposal });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  let scope;
  try { scope = await requireScope({ area: "knowledge", edit: true }); }
  catch (err) { return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 }); }

  const { id } = await ctx.params;
  await query("DELETE FROM strategy_versions WHERE strategy_id = $1 AND user_id = $2", [id, scope.dataId]).catch(() => {});
  await query("DELETE FROM strategies WHERE id = $1 AND user_id = $2", [id, scope.dataId]);
  return NextResponse.json({ ok: true });
}
