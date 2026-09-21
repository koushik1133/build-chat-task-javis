import { query, queryOne } from "@/lib/dsql";
import { isValidCron, nextRun } from "@/lib/cron-expr";
import { startRun } from "./runner";

/**
 * Schedule triggers: promote due `agent_triggers` rows into queued runs.
 *
 * Firing is claimed with a conditional UPDATE on `next_run_at`, so two ticks
 * that overlap never start the same scheduled run twice.
 */

export interface TriggerRow {
  id: string;
  user_id: string;
  agent_id: string;
  kind: string;
  cron_expr: string | null;
  timezone: string | null;
  event_type: string | null;
  config: string | null;
  enabled: boolean | null;
  next_run_at: string | null;
  last_run_at: string | null;
  created_at: string;
}

export interface TriggerConfig {
  prompt?: string;
  [key: string]: unknown;
}

export function parseTriggerConfig(raw: string | null | undefined): TriggerConfig {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as TriggerConfig) : {};
  } catch {
    return {};
  }
}

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Next firing time for a schedule, or null when the expression is invalid / never fires. */
export function computeNextRun(cronExpr: string, timezone = "UTC", from: Date = new Date()): Date | null {
  if (!isValidCron(cronExpr)) return null;
  const tz = timezone && isValidTimezone(timezone) ? timezone : "UTC";
  return nextRun(cronExpr, from, tz);
}

export interface PromoteResult {
  promoted: number;
  scheduled: number;
  errors: number;
}

export async function promoteDueTriggers(now: Date = new Date()): Promise<PromoteResult> {
  const result: PromoteResult = { promoted: 0, scheduled: 0, errors: 0 };
  const nowIso = now.toISOString();

  const due = await query<TriggerRow>(
    `SELECT * FROM agent_triggers
     WHERE kind = 'schedule' AND enabled = TRUE
       AND (next_run_at IS NULL OR next_run_at <= $1)
     ORDER BY next_run_at ASC NULLS FIRST
     LIMIT 100`,
    [nowIso]
  ).catch(() => []);

  for (const t of due) {
    try {
      if (!t.cron_expr || !isValidCron(t.cron_expr)) continue;
      const tz = t.timezone && isValidTimezone(t.timezone) ? t.timezone : "UTC";
      const next = computeNextRun(t.cron_expr, tz, now);
      const nextIso = next ? next.toISOString() : null;

      if (!t.next_run_at) {
        // First sighting: schedule it, don't fire retroactively.
        await query(`UPDATE agent_triggers SET next_run_at = $2 WHERE id = $1 AND next_run_at IS NULL`, [t.id, nextIso]);
        result.scheduled++;
        continue;
      }

      // Claim this firing; a concurrent tick loses the race and skips.
      const claimed = await queryOne<{ id: string }>(
        `UPDATE agent_triggers SET next_run_at = $2, last_run_at = $3
         WHERE id = $1 AND enabled = TRUE AND next_run_at = $4
         RETURNING id`,
        [t.id, nextIso, nowIso, t.next_run_at]
      ).catch(() => null);
      if (!claimed) continue;

      const config = parseTriggerConfig(t.config);
      await startRun(t.user_id, t.agent_id, {
        prompt: typeof config.prompt === "string" ? config.prompt : null,
        triggerKind: "schedule",
        triggerRef: t.id,
        workflowName: "Scheduled",
      });
      result.promoted++;
    } catch (err) {
      result.errors++;
      console.error(`[triggers] failed to promote ${t.id}:`, err);
    }
  }

  return result;
}
