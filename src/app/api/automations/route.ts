import { NextResponse } from "next/server";
import { requireUser } from "@/lib/supabase/server";
import { query, queryOne } from "@/lib/dsql";

export async function GET() {
  let user;
  try { ({ user } = await requireUser()); }
  catch { return NextResponse.json({ error: "unauthorized" }, { status: 401 }); }
  const workflows = await query(
    "SELECT * FROM automations WHERE user_id = $1 ORDER BY created_at DESC",
    [user.id]
  ).catch(() => []);
  return NextResponse.json({ workflows });
}

export async function POST(req: Request) {
  let user;
  try { ({ user } = await requireUser()); }
  catch { return NextResponse.json({ error: "unauthorized" }, { status: 401 }); }
  const {
    name, trigger, action, kanban_label, action_config,
    schedule_time, schedule_timezone, schedule_days,
  } = await req.json();
  if (!name?.trim()) return NextResponse.json({ error: "name required" }, { status: 400 });

  const isScheduled = trigger === "Scheduled (Daily)";
  if (isScheduled && !schedule_time) {
    return NextResponse.json({ error: "schedule_time required for daily automations" }, { status: 400 });
  }
  if (!isScheduled && !kanban_label?.trim()) {
    return NextResponse.json({ error: "kanban_label required for Kanban automations" }, { status: 400 });
  }

  try {
    const workflow = await queryOne(
      `INSERT INTO automations
         (user_id, name, trigger_event, action_type, kanban_label, action_config,
          schedule_time, schedule_timezone, schedule_days, status, run_count)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'active', 0) RETURNING *`,
      [
        user.id,
        name.trim(),
        trigger ?? "Scheduled (Daily)",
        action ?? "Send Notification",
        isScheduled ? null : kanban_label?.trim(),
        JSON.stringify(action_config ?? {}),
        isScheduled ? schedule_time : null,
        isScheduled ? (schedule_timezone ?? "America/Chicago") : null,
        isScheduled ? (schedule_days ?? "daily") : null,
      ]
    );
    if (!workflow) {
      return NextResponse.json({ error: "Failed to create workflow" }, { status: 500 });
    }
    return NextResponse.json({ workflow });
  } catch (err) {
    const msg = (err as Error).message ?? "";
    if (msg.includes("does not exist")) {
      return NextResponse.json({
        error: "Database schema out of date",
        detail: "Run the automations migration SQL in DSQL (see aws/schema.sql comments), then try again.",
        db_error: msg,
      }, { status: 500 });
    }
    return NextResponse.json({
      error: "Failed to create workflow",
      detail: msg || "Database error",
    }, { status: 503 });
  }
}
