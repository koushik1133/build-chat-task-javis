import { NextResponse } from "next/server";
import { requireUser } from "@/lib/supabase/server";
import { queryOne, query } from "@/lib/dsql";
import { colById } from "@/lib/production-board";
import { getUserBoardColumns, logProductionActivity } from "@/lib/production-server";

export async function GET() {
  let user;
  try { ({ user } = await requireUser()); }
  catch { return NextResponse.json({ error: "unauthorized" }, { status: 401 }); }
  const tasks = await query(
    "SELECT * FROM production_tasks WHERE user_id = $1 ORDER BY created_at DESC",
    [user.id]
  ).catch(() => []);
  return NextResponse.json({ tasks });
}

export async function POST(req: Request) {
  let user;
  try { ({ user } = await requireUser()); }
  catch { return NextResponse.json({ error: "unauthorized" }, { status: 401 }); }

  const body = await req.json();
  const {
    title,
    status,
    priority = "medium",
    description = null,
    due_date = null,
    tags = "[]",
    assignee = null,
    automation = null,
    source = "manual",
  } = body;

  if (!title?.trim()) return NextResponse.json({ error: "title required" }, { status: 400 });

  const cols = await getUserBoardColumns(user.id);
  let resolvedStatus = status ?? cols[0]?.id ?? "todo";

  // Automations/agents land in first HITL column when one exists
  if (source === "automation" || source === "agent") {
    const hitlCol = cols.find(c => c.hitl);
    if (hitlCol) resolvedStatus = hitlCol.id;
  }

  const task = await queryOne(
    `INSERT INTO production_tasks (user_id, title, status, priority, description, due_date, tags, assignee, automation)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [user.id, title.trim(), resolvedStatus, priority, description, due_date, tags, assignee, automation]
  ).catch(() => null);

  if (!task) return NextResponse.json({ error: "insert failed" }, { status: 500 });

  const col = colById(cols, resolvedStatus);
  await logProductionActivity(user.id, (task as { id: string }).id, "created", {
    column: col?.label ?? resolvedStatus,
    source,
    hitl: col?.hitl ?? false,
  });

  return NextResponse.json({ task });
}
