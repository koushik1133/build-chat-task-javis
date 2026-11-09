import { query, queryOne } from "@/lib/dsql";
import { tableExists } from "@/lib/table-exists";
import { cronAgeMinutes } from "@/lib/metrics/collect";

/** Metric samplers for alert rules. Org metrics are always filtered by user_id = data id. */

async function n(sql: string, params: unknown[]): Promise<number> {
  const row = await queryOne<{ n: string | number | null }>(sql, params).catch(() => null);
  return Number(row?.n ?? 0);
}

const SAMPLERS: Record<string, (dataId: string, win: number) => Promise<number | null>> = {
  outbox_failed: async (d, w) => ((await tableExists("notification_outbox")) ? n(`SELECT COUNT(*) AS n FROM notification_outbox WHERE user_id = $1 AND status = 'failed' AND created_at >= NOW() - ($2 || ' minutes')::interval`, [d, String(w)]) : null),
  sla_breaches_open: async (d) => ((await tableExists("tickets")) ? n(`SELECT COUNT(*) AS n FROM tickets WHERE user_id = $1 AND status IN ('open','pending') AND (breached_first_response OR breached_resolution)`, [d]) : null),
  webhook_dead: async (d, w) => ((await tableExists("webhook_deliveries")) ? n(`SELECT COUNT(*) AS n FROM webhook_deliveries WHERE user_id = $1 AND status = 'dead' AND created_at >= NOW() - ($2 || ' minutes')::interval`, [d, String(w)]) : null),
  accounting_sync_errors: async (d, w) => ((await tableExists("accounting_sync_log")) ? n(`SELECT COUNT(*) AS n FROM accounting_sync_log WHERE user_id = $1 AND status = 'error' AND created_at >= NOW() - ($2 || ' minutes')::interval`, [d, String(w)]) : null),
  invoices_past_due: async (d) => n(`SELECT COUNT(*) AS n FROM invoices WHERE user_id = $1 AND status IN ('sent','partially_paid','overdue') AND due_at < NOW()`, [d]),
  ai_budget_pct: async (d) => {
    const b = await queryOne<{ cap: string | number | null }>(`SELECT monthly_cap_micros AS cap FROM ai_budgets WHERE user_id = $1`, [d]).catch(() => null);
    const cap = Number(b?.cap ?? 0);
    if (!cap) return null;
    const spent = await n(`SELECT COALESCE(SUM(cost_micros), 0) AS n FROM ai_usage WHERE user_id = $1 AND created_at >= date_trunc('month', NOW())`, [d]);
    return Math.round((spent / cap) * 1000) / 10;
  },
  agent_failure_rate: async (d, w) => {
    const r = await queryOne<{ bad: string | number; total: string | number }>(
      `SELECT COUNT(*) FILTER (WHERE status IN ('failed','dead')) AS bad, COUNT(*) AS total FROM agent_jobs WHERE user_id = $1 AND created_at >= NOW() - ($2 || ' minutes')::interval`,
      [d, String(w)]
    ).catch(() => null);
    const total = Number(r?.total ?? 0);
    return total < 5 ? 0 : Math.round((Number(r?.bad ?? 0) / total) * 1000) / 10;
  },
  sync_errors: async (d) => {
    const mail = (await tableExists("mail_accounts")) ? await n(`SELECT COUNT(*) AS n FROM mail_accounts WHERE user_id = $1 AND status = 'error'`, [d]) : 0;
    const cal = (await tableExists("calendar_connections")) ? await n(`SELECT COUNT(*) AS n FROM calendar_connections WHERE user_id = $1 AND status = 'error'`, [d]) : 0;
    return mail + cal;
  },
};

const PLATFORM: Record<string, (win: number) => Promise<number | null>> = {
  cron_stale: async () => {
    const a = await cronAgeMinutes();
    return a === null ? null : Math.round(a * 10) / 10;
  },
  jobs_queued: (): Promise<number | null> => n(`SELECT COUNT(*) AS n FROM agent_jobs WHERE status = 'queued'`, []),
  outbox_failed_all: (w) => n(`SELECT COUNT(*) AS n FROM notification_outbox WHERE status = 'failed' AND created_at >= NOW() - ($1 || ' minutes')::interval`, [String(w)]),
};

/** Sample one metric. `dataId` null = platform scope. Unknown metrics or wrong scope yield null. */
export async function sampleMetric(metric: string, dataId: string | null, windowMin: number): Promise<number | null> {
  try {
    if (dataId === null) return PLATFORM[metric] ? await PLATFORM[metric](windowMin) : null;
    return SAMPLERS[metric] ? await SAMPLERS[metric](dataId, windowMin) : null;
  } catch {
    return null;
  }
}

export async function orgsWithoutRules(limit: number): Promise<string[]> {
  const rows = await query<{ user_id: string }>(
    `SELECT DISTINCT o.user_id FROM notification_outbox o
      WHERE o.status = 'failed' AND o.created_at >= NOW() - INTERVAL '1 day'
        AND NOT EXISTS (SELECT 1 FROM alert_rules r WHERE r.user_id = o.user_id) LIMIT $1`,
    [limit]
  ).catch(() => []);
  return rows.map((r) => r.user_id);
}
