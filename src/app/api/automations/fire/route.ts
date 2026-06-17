import { NextResponse } from "next/server";
import { requireUser } from "@/lib/supabase/server";
import { getUserBoardColumns, fireKanbanAutomations } from "@/lib/production-server";
import { shouldFireAutomations } from "@/lib/production-board";

export async function POST(req: Request) {
  let user;
  try { ({ user } = await requireUser()); }
  catch { return NextResponse.json({ error: "unauthorized" }, { status: 401 }); }

  const { label, task_title, to_column, from_column, via_approval = false } = await req.json();
  if (!label) return NextResponse.json({ fired: [] });

  const cols = await getUserBoardColumns(user.id);
  const fromCol = cols.find(c => c.label === from_column || c.id === from_column);
  const toCol = cols.find(c => c.label === to_column || c.id === to_column);

  if (fromCol && toCol) {
    if (!shouldFireAutomations(cols, fromCol.id, toCol.id, !!via_approval)) {
      return NextResponse.json({ fired: [], skipped: true, reason: "HITL gate — waiting for approval" });
    }
  } else if (toCol?.hitl) {
    return NextResponse.json({ fired: [], skipped: true, reason: "Entering HITL column" });
  }

  const fired = await fireKanbanAutomations(user.id, label, {
    task_title: task_title ?? "",
    from_column,
    to_column,
    via_approval,
  });

  return NextResponse.json({ fired, context: { label, task_title, to_column, via_approval } });
}
