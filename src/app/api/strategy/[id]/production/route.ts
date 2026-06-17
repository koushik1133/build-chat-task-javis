import { NextResponse } from "next/server";
import { requireUser } from "@/lib/supabase/server";
import { queryOne } from "@/lib/dsql";
import { parseProductionTasks } from "@/lib/strategy";
import { getUserBoardColumns, logProductionActivity } from "@/lib/production-server";
import { colById } from "@/lib/production-board";

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  let user;
  try { ({ user } = await requireUser()); }
  catch { return NextResponse.json({ error: "unauthorized" }, { status: 401 }); }

  const { id } = await ctx.params;
  const strategy = await queryOne<{ title: string; content: string }>(
    "SELECT title, content FROM strategies WHERE id = $1 AND user_id = $2",
    [id, user.id]
  ).catch(() => null);

  if (!strategy) return NextResponse.json({ error: "not found" }, { status: 404 });

  const taskTitles = parseProductionTasks(strategy.content);
  if (taskTitles.length === 0) {
    return NextResponse.json({ error: "No suggested production tasks found in this strategy." }, { status: 400 });
  }

  const cols = await getUserBoardColumns(user.id);
  const hitlCol = cols.find(c => c.hitl);
  const status = hitlCol?.id ?? cols[0]?.id ?? "todo";

  const created: unknown[] = [];
  for (const title of taskTitles) {
    const task = await queryOne(
      `INSERT INTO production_tasks (user_id, title, status, priority, description, tags, automation)
       VALUES ($1, $2, $3, 'medium', $4, $5, $6) RETURNING *`,
      [
        user.id,
        title,
        status,
        `From strategy: ${strategy.title}`,
        JSON.stringify(["strategy"]),
        `strategy:${id}`,
      ]
    ).catch(() => null);

    if (task) {
      created.push(task);
      const col = colById(cols, status);
      await logProductionActivity(user.id, (task as { id: string }).id, "created", {
        column: col?.label ?? status,
        source: "strategy",
        strategy_id: id,
        hitl: col?.hitl ?? false,
      });
    }
  }

  return NextResponse.json({ ok: true, created: created.length, tasks: created });
}
