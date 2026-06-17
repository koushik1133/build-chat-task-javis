import { NextResponse } from "next/server";
import { requireUser } from "@/lib/supabase/server";
import { getAutomationById, runAutomation } from "@/lib/automation-runner";

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  let user;
  try { ({ user } = await requireUser()); }
  catch { return NextResponse.json({ error: "unauthorized" }, { status: 401 }); }

  const { id } = await ctx.params;
  const row = await getAutomationById(user.id, id);
  if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });

  const result = await runAutomation(user.id, row, {
    task_title: row.trigger_event === "Scheduled (Daily)"
      ? "Test scheduled run"
      : "Test card (manual run)",
    from_column: row.trigger_event === "Scheduled (Daily)" ? "Schedule" : "Test",
    to_column: row.trigger_event === "Scheduled (Daily)" ? "Run" : "Test",
    kanban_label: row.trigger_event === "Scheduled (Daily)" ? undefined : "test-run",
    via_approval: row.trigger_event !== "Scheduled (Daily)",
  });

  return NextResponse.json({ result });
}
