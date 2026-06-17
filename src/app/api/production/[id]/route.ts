import { NextResponse } from "next/server";
import { requireUser } from "@/lib/supabase/server";
import { query, queryOne } from "@/lib/dsql";
import { validateMove, shouldFireAutomations, colById } from "@/lib/production-board";
import {
  getUserBoardColumns,
  logProductionActivity,
  fireKanbanAutomations,
} from "@/lib/production-server";

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  let user;
  try { ({ user } = await requireUser()); }
  catch { return NextResponse.json({ error: "unauthorized" }, { status: 401 }); }

  const { id } = await ctx.params;
  const body = await req.json();

  const existing = await queryOne<{ id: string; title: string; status: string; automation: string | null }>(
    "SELECT id, title, status, automation FROM production_tasks WHERE id = $1 AND user_id = $2",
    [id, user.id]
  ).catch(() => null);

  if (!existing) return NextResponse.json({ error: "not found" }, { status: 404 });

  const cols = await getUserBoardColumns(user.id);

  if (body.status !== undefined && body.status !== existing.status) {
    const check = validateMove(cols, existing.status, body.status);
    if (!check.ok) {
      return NextResponse.json({ error: check.reason }, { status: 403 });
    }
  }

  const setClauses: string[] = [];
  const values: unknown[] = [];

  if (body.title       !== undefined) { setClauses.push(`title = $${setClauses.length + 1}`);       values.push(body.title); }
  if (body.description !== undefined) { setClauses.push(`description = $${setClauses.length + 1}`); values.push(body.description); }
  if (body.status      !== undefined) { setClauses.push(`status = $${setClauses.length + 1}`);      values.push(body.status); }
  if (body.priority    !== undefined) { setClauses.push(`priority = $${setClauses.length + 1}`);    values.push(body.priority); }
  if (body.due_date    !== undefined) { setClauses.push(`due_date = $${setClauses.length + 1}`);    values.push(body.due_date); }
  if (body.tags        !== undefined) { setClauses.push(`tags = $${setClauses.length + 1}`);        values.push(body.tags); }
  if (body.assignee    !== undefined) { setClauses.push(`assignee = $${setClauses.length + 1}`);    values.push(body.assignee); }
  if (body.automation  !== undefined) { setClauses.push(`automation = $${setClauses.length + 1}`);  values.push(body.automation); }

  if (setClauses.length === 0) return NextResponse.json({ ok: true });

  const idIdx = setClauses.length + 1;
  const userIdIdx = setClauses.length + 2;
  values.push(id, user.id);

  const task = await queryOne(
    `UPDATE production_tasks SET ${setClauses.join(", ")} WHERE id = $${idIdx} AND user_id = $${userIdIdx} RETURNING *`,
    values
  ).catch(() => null);

  if (!task) return NextResponse.json({ error: "update failed" }, { status: 500 });

  const newStatus = body.status as string | undefined;
  let fired: { id: string; name: string; action: string }[] = [];

  if (newStatus && newStatus !== existing.status) {
    const fromCol = colById(cols, existing.status);
    const toCol = colById(cols, newStatus);
    await logProductionActivity(user.id, id, "moved", {
      from: fromCol?.label ?? existing.status,
      to: toCol?.label ?? newStatus,
    });

    if (
      existing.automation &&
      shouldFireAutomations(cols, existing.status, newStatus, false)
    ) {
      fired = await fireKanbanAutomations(user.id, existing.automation, {
        task_title: existing.title,
        from_column: fromCol?.label,
        to_column: toCol?.label ?? newStatus,
        via_approval: false,
      });
    }
  } else if (body.title || body.description || body.priority || body.due_date || body.tags || body.assignee || body.automation) {
    await logProductionActivity(user.id, id, "updated", {});
  }

  return NextResponse.json({ task, fired });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  let user;
  try { ({ user } = await requireUser()); }
  catch { return NextResponse.json({ error: "unauthorized" }, { status: 401 }); }
  const { id } = await ctx.params;

  const existing = await queryOne<{ title: string }>(
    "SELECT title FROM production_tasks WHERE id = $1 AND user_id = $2",
    [id, user.id]
  ).catch(() => null);

  if (existing) {
    await logProductionActivity(user.id, id, "deleted", { title: existing.title });
  }

  await query("DELETE FROM production_tasks WHERE id = $1 AND user_id = $2", [id, user.id]);
  return NextResponse.json({ ok: true });
}
