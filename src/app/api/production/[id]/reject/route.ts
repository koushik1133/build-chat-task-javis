import { NextResponse } from "next/server";
import { requireUser } from "@/lib/supabase/server";
import { query, queryOne } from "@/lib/dsql";
import { getUserBoardColumns, logProductionActivity } from "@/lib/production-server";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  let user;
  try { ({ user } = await requireUser()); }
  catch { return NextResponse.json({ error: "unauthorized" }, { status: 401 }); }

  const { id } = await ctx.params;
  const body = await req.json().catch(() => ({}));
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";

  const cols = await getUserBoardColumns(user.id);
  const task = await queryOne<{ id: string; title: string; status: string }>(
    "SELECT id, title, status FROM production_tasks WHERE id = $1 AND user_id = $2",
    [id, user.id]
  ).catch(() => null);

  if (!task) return NextResponse.json({ error: "not found" }, { status: 404 });

  const current = cols.find(c => c.id === task.status);

  await logProductionActivity(user.id, id, "rejected", {
    column: current?.label ?? task.status,
    reason: reason || null,
    title: task.title,
  });

  await query("DELETE FROM production_tasks WHERE id = $1 AND user_id = $2", [id, user.id]);

  return NextResponse.json({ ok: true });
}
