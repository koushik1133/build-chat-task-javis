import { NextResponse } from "next/server";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { randomUUID } from "crypto";
import { query, queryOne } from "@/lib/dsql";
import { emitEvent } from "@/lib/events/bus";
import { getUserBoardColumns, logProductionActivity } from "@/lib/production-server";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  let scope;
  try { scope = await requireScope({ area: "production", edit: true }); }
  catch (err) { return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 }); }

  const { id } = await ctx.params;
  const body = await req.json().catch(() => ({}));
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";

  const cols = await getUserBoardColumns(scope.dataId);
  const task = await queryOne<{ id: string; title: string; status: string }>(
    "SELECT id, title, status FROM production_tasks WHERE id = $1 AND user_id = $2",
    [id, scope.dataId]
  ).catch(() => null);

  if (!task) return NextResponse.json({ error: "not found" }, { status: 404 });

  const current = cols.find(c => c.id === task.status);

  await logProductionActivity(scope.dataId, id, "rejected", {
    column: current?.label ?? task.status,
    reason: reason || null,
    title: task.title,
  });

  await query("DELETE FROM production_tasks WHERE id = $1 AND user_id = $2", [id, scope.dataId]);

  // Mirror the decision into the unified approvals inbox (history only).
  await query(
    `INSERT INTO approvals (id, user_id, run_id, agent_id, tool_name, input, preview, status, decided_by, decided_at)
     VALUES ($1, $2, NULL, NULL, 'production.card', $3, $4, 'rejected', $2, NOW())`,
    [randomUUID(), scope.dataId, JSON.stringify({ card_id: id, column: current?.id ?? task.status, reason: reason || null }), task.title]
  ).catch((err) => console.error("[production] approvals mirror failed", err));
  void emitEvent(scope.dataId, {
    type: "production.card.rejected",
    entity: "production_task",
    entityId: id,
    data: { column: current?.id ?? task.status, reason: reason || null, title: task.title },
  });

  return NextResponse.json({ ok: true });
}
