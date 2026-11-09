import { query } from "@/lib/dsql";
import { tableExists } from "@/lib/table-exists";
import { CRON_TICK_KEY, getSystemState } from "@/lib/system/state";
import type { Gauge } from "./registry";

/**
 * DB-derived gauges, computed lazily and cached for 15s so scrapes never
 * hammer the database. Platform-wide (deployment) numbers: the /api/metrics
 * route is guarded by METRICS_TOKEN, not by tenant scope.
 */

const TTL_MS = 15_000;
let cache: { at: number; gauges: Gauge[] } | null = null;

async function groupCounts(table: string, statusCol = "status"): Promise<Array<{ status: string; n: number }>> {
  if (!(await tableExists(table))) return [];
  const rows = await query<{ status: string; n: string | number }>(`SELECT ${statusCol} AS status, COUNT(*) AS n FROM ${table} GROUP BY ${statusCol}`).catch(() => []);
  return rows.map((r) => ({ status: String(r.status), n: Number(r.n) }));
}

export async function cronAgeMinutes(): Promise<number | null> {
  const s = await getSystemState<{ at?: string }>(CRON_TICK_KEY).catch(() => null);
  if (!s) return null;
  const at = Date.parse(s.value?.at ?? s.updatedAt);
  return Number.isFinite(at) ? Math.max(0, (Date.now() - at) / 60_000) : null;
}

export async function collectGauges(now = Date.now()): Promise<Gauge[]> {
  if (cache && now - cache.at < TTL_MS) return cache.gauges;
  const gauges: Gauge[] = [];
  const age = await cronAgeMinutes();
  if (age !== null) gauges.push({ name: "kh_cron_last_tick_age_minutes", help: "Minutes since the last completed cron tick.", value: Math.round(age * 10) / 10 });

  for (const r of await groupCounts("notification_outbox")) gauges.push({ name: "kh_outbox_rows", help: "notification_outbox rows by status.", value: r.n, labels: { status: r.status } });
  for (const r of await groupCounts("agent_jobs")) gauges.push({ name: "kh_agent_jobs", help: "agent_jobs rows by status.", value: r.n, labels: { status: r.status } });
  for (const r of await groupCounts("webhook_deliveries")) if (r.status === "dead" || r.status === "queued" || r.status === "failed") gauges.push({ name: "kh_webhook_deliveries", help: "webhook_deliveries rows by status (dead = dead letters).", value: r.n, labels: { status: r.status } });

  if (await tableExists("ai_usage")) {
    const row = await query<{ micros: string | null }>(`SELECT COALESCE(SUM(cost_micros), 0) AS micros FROM ai_usage WHERE created_at >= date_trunc('day', NOW())`).catch(() => []);
    gauges.push({ name: "kh_llm_spend_today_micros", help: "LLM spend today across all workspaces, in millionths of a dollar.", value: Number(row[0]?.micros ?? 0) });
  }
  cache = { at: now, gauges };
  return gauges;
}

export function resetCollectCache(): void {
  cache = null;
}
