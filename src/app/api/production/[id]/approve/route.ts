import { NextResponse } from "next/server";
import { requireUser } from "@/lib/supabase/server";
import { queryOne } from "@/lib/dsql";
import { nextColumn, shouldFireAutomations } from "@/lib/production-board";
import {
  getUserBoardColumns,
  logProductionActivity,
  fireKanbanAutomations,
} from "@/lib/production-server";

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  let user;
  try { ({ user } = await requireUser()); }
  catch { return NextResponse.json({ error: "unauthorized" }, { status: 401 }); }

  const { id } = await ctx.params;
  const cols = await getUserBoardColumns(user.id);

  const task = await queryOne<{
    id: string; title: string; status: string; automation: string | null;
  }>(
    "SELECT id, title, status, automation FROM production_tasks WHERE id = $1 AND user_id = $2",
    [id, user.id]
  ).catch(() => null);

  if (!task) return NextResponse.json({ error: "not found" }, { status: 404 });

  const current = cols.find(c => c.id === task.status);
  if (!current?.hitl) {
    return NextResponse.json({ error: "Card is not in a HITL gate column" }, { status: 400 });
  }

  const next = nextColumn(cols, task.status);
  if (!next) {
    return NextResponse.json({ error: "No column after HITL gate" }, { status: 400 });
  }

  const updated = await queryOne(
    `UPDATE production_tasks SET status = $1, approved_at = NOW() WHERE id = $2 AND user_id = $3 RETURNING *`,
    [next.id, id, user.id]
  ).catch(() => null);

  if (!updated) return NextResponse.json({ error: "update failed" }, { status: 500 });

  await logProductionActivity(user.id, id, "approved", {
    from: current.label,
    to: next.label,
    from_id: current.id,
    to_id: next.id,
  });

  let fired: { id: string; name: string; action: string }[] = [];
  if (
    task.automation &&
    shouldFireAutomations(cols, current.id, next.id, true)
  ) {
    fired = await fireKanbanAutomations(user.id, task.automation, {
      task_title: task.title,
      from_column: current.label,
      to_column: next.label,
      via_approval: true,
    });
  }

  return NextResponse.json({ task: updated, fired, next_column: next.label });
}
