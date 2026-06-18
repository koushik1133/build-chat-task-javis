import { NextResponse } from "next/server";
import { query, queryOne } from "@/lib/dsql";
import { runAutomation } from "@/lib/automation-runner";
import { getLocalNow, isScheduleDue } from "@/lib/automation-scheduler";

export const runtime = "nodejs";
export const maxDuration = 60;

type ScheduledRow = {
  id: string;
  user_id: string;
  name: string;
  action_type: string;
  action_config: string | null;
  trigger_event: string;
  schedule_time: string | null;
  schedule_timezone: string | null;
  schedule_days: string | null;
  last_scheduled_date: string | null;
};

async function handleCron(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 503 });
  }

  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const tickStart = Date.now();

  const rows = await query(
    `SELECT id, user_id, name, action_type, action_config, trigger_event,
            schedule_time, schedule_timezone, schedule_days, last_scheduled_date
     FROM automations
     WHERE status = 'active' AND trigger_event = 'Scheduled (Daily)'`
  ).catch(() => []);

  const scheduled = rows as ScheduledRow[];
  const due: Array<{ row: ScheduledRow; local: ReturnType<typeof getLocalNow> }> = [];

  for (const row of scheduled) {
    const tz = row.schedule_timezone ?? "UTC";
    const local = getLocalNow(tz);
    if (isScheduleDue(row, local)) {
      due.push({ row, local });
    }
  }

  const ran: Array<{
    id: string;
    name: string;
    success: boolean;
    message: string;
    fired_at: string;
    latency_ms: number;
  }> = [];

  const FAST_ACTIONS = new Set([
    "Send Email",
    "Send Slack Message",
    "Send Notification",
    "Trigger Webhook",
    "Create Task",
  ]);

  await Promise.all(
    due.map(async ({ row, local }) => {
      // Claim immediately so parallel 1s ticks don't double-fire
      const claimed = await queryOne<{ id: string }>(
        `UPDATE automations SET last_scheduled_date = $1
         WHERE id = $2 AND (last_scheduled_date IS DISTINCT FROM $1)
         RETURNING id`,
        [local.date, row.id]
      ).catch(() => null);

      if (!claimed) return;

      const fireAt = new Date().toISOString();
      const ctx = {
        task_title: `Scheduled run — ${local.date} ${local.time}`,
        from_column: "Schedule",
        to_column: "Run",
        via_approval: false,
      };

      // Email/Slack/etc. must finish before cron returns; agents can run in background.
      if (FAST_ACTIONS.has(row.action_type)) {
        try {
          const result = await runAutomation(row.user_id, row, ctx);
          ran.push({
            id: row.id,
            name: row.name,
            success: result.success,
            message: result.message,
            fired_at: fireAt,
            latency_ms: Date.now() - tickStart,
          });
        } catch (err) {
          console.error(`[cron] run failed for ${row.id}:`, err);
          ran.push({
            id: row.id,
            name: row.name,
            success: false,
            message: err instanceof Error ? err.message : "run failed",
            fired_at: fireAt,
            latency_ms: Date.now() - tickStart,
          });
        }
        return;
      }

      ran.push({
        id: row.id,
        name: row.name,
        success: true,
        message: "Started in background",
        fired_at: fireAt,
        latency_ms: Date.now() - tickStart,
      });

      void runAutomation(row.user_id, row, ctx).catch(err => {
        console.error(`[cron] background run failed for ${row.id}:`, err);
      });
    })
  );

  return NextResponse.json({
    ok: true,
    checked: scheduled.length,
    due: due.length,
    ran,
    tick_ms: Date.now() - tickStart,
    server_time: new Date().toISOString(),
  });
}

export async function GET(req: Request) {
  try {
    return await handleCron(req);
  } catch (err) {
    console.error("[cron] unhandled:", err);
    return NextResponse.json(
      { error: "cron failed", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  try {
    return await handleCron(req);
  } catch (err) {
    console.error("[cron] unhandled:", err);
    return NextResponse.json(
      { error: "cron failed", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
