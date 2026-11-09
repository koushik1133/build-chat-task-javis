import { timingSafeEqual } from "crypto";
import { NextResponse } from "next/server";
import { query, queryOne } from "@/lib/dsql";
import { runAutomation } from "@/lib/automation-runner";
import { getLocalNow, isScheduleDue } from "@/lib/automation-scheduler";
import { fanOutEvents, fireDueSchedules } from "@/lib/automations/triggers";
import { runQueued } from "@/lib/automations/engine";

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

  const auth = Buffer.from(req.headers.get("authorization") ?? "");
  const want = Buffer.from(`Bearer ${secret}`);
  if (auth.length !== want.length || !timingSafeEqual(auth, want)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const tickStart = Date.now();

  // Legacy daily automations: rows the v2 engine has not adopted yet (trigger_type IS NULL).
  // Before aws/phase7/c.sql adds `trigger_type`, every row is legacy — fall back to the
  // pre-Phase-7 query so existing schedules keep firing instead of silently stopping.
  const legacySelect = `SELECT id, user_id, name, action_type, action_config, trigger_event,
            schedule_time, schedule_timezone, schedule_days, last_scheduled_date
     FROM automations
     WHERE status = 'active' AND trigger_event = 'Scheduled (Daily)'`;
  const rows = await query(`${legacySelect} AND trigger_type IS NULL`).catch(async (err: unknown) => {
    if (err instanceof Error && /trigger_type/i.test(err.message)) return query(legacySelect).catch(() => []);
    console.error("[cron/automations] legacy schedule query failed:", err);
    return [];
  });

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
            message: "run failed",
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

  // v2 engine: events → queued runs, due schedules, then execute/resume.
  const v2 = { fanout: 0, schedules: 0, done: 0, waiting: 0, failed: 0, resumed: 0, reaped: 0 };
  try { v2.fanout = (await fanOutEvents(200)).queued; } catch (err) { console.error("[cron/automations] fan-out failed:", err); }
  try { v2.schedules = (await fireDueSchedules()).queued; } catch (err) { console.error("[cron/automations] schedules failed:", err); }
  try { const r = await runQueued(50); v2.done = r.done; v2.waiting = r.waiting; v2.failed = r.failed; v2.resumed = r.resumed; v2.reaped = r.reaped; } catch (err) { console.error("[cron/automations] run queue failed:", err); }

  return NextResponse.json({
    ok: true,
    v2,
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
      { error: "cron failed" },
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
      { error: "cron failed" },
      { status: 500 }
    );
  }
}
