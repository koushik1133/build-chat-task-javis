import { NextResponse } from "next/server";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { query, queryOne } from "@/lib/dsql";

export async function GET() {
  let scope;
  try { scope = await requireScope({ area: "agents", edit: false }); }
  catch (err) { return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 }); }
  const workflows = await query(
    "SELECT * FROM automations WHERE user_id = $1 ORDER BY created_at DESC",
    [scope.dataId]
  ).catch(() => []);
  return NextResponse.json({ workflows });
}

export async function POST(req: Request) {
  let scope;
  try { scope = await requireScope({ area: "agents", edit: true }); }
  catch (err) { return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 }); }
  const rawBody = await req.json().catch(() => null);
  if (!rawBody || typeof rawBody !== "object") return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  const {
    name, trigger, action, kanban_label, action_config,
    schedule_time, schedule_timezone, schedule_days,
  } = rawBody;
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
        scope.dataId,
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
    console.error("[automations] create workflow failed:", err);
    return NextResponse.json({ error: "Failed to create workflow" }, { status: 503 });
  }
}
