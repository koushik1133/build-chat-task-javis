import { query, queryOne } from "@/lib/dsql";
import { METRICS, type Metric } from "./catalog";
import { monthStart } from "./rules";

/** Usage measurement and lightweight counters. */

function n(v: unknown): number {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}

async function count(sql: string, params: unknown[]): Promise<number> {
  const row = await queryOne<{ c: string | number }>(sql, params);
  return n(row?.c);
}

/** Current value of one metric. Counts run on demand; counters are per calendar month (UTC). */
export async function measure(dataId: string, metric: Metric, now = new Date()): Promise<number> {
  switch (metric) {
    case "contacts":
      return count(`SELECT COUNT(*) AS c FROM crm_contacts WHERE user_id = $1 AND deleted_at IS NULL`, [dataId]);
    case "seats":
      return count(
        `SELECT COUNT(*) AS c FROM memberships m JOIN organizations o ON o.id = m.org_id
          WHERE o.owner_user_id = $1 AND m.status IN ('active', 'invited')`,
        [dataId]
      );
    case "child_workspaces":
      return count(
        `SELECT COUNT(*) AS c FROM organizations c JOIN organizations p ON c.parent_org_id = p.id
          WHERE p.owner_user_id = $1 AND c.archived_at IS NULL`,
        [dataId]
      );
    case "storage_mb": {
      const row = await queryOne<{ b: string | number | null }>(`SELECT COALESCE(SUM(size_bytes), 0) AS b FROM attachments WHERE user_id = $1 AND deleted_at IS NULL`, [dataId]);
      return Math.ceil(n(row?.b) / (1024 * 1024));
    }
    case "api_keys":
      return count(`SELECT COUNT(*) AS c FROM api_keys WHERE user_id = $1 AND revoked_at IS NULL`, [dataId]);
    case "ai_credits_used": {
      const row = await queryOne<{ c: string | number | null }>(
        `SELECT COALESCE(SUM(-credits), 0) AS c FROM ai_credit_ledger
          WHERE user_id = $1 AND kind IN ('usage', 'outcome') AND created_at >= $2::date`,
        [dataId, monthStart(now)]
      );
      return Math.max(0, n(row?.c));
    }
    case "api_calls":
      return readCounter(dataId, "api_calls", now);
  }
}

export async function measureAll(dataId: string, now = new Date()): Promise<Record<Metric, number>> {
  const out = {} as Record<Metric, number>;
  const results = await Promise.all(METRICS.map((m) => measure(dataId, m, now).catch((err) => {
    console.warn(`[plans] measure ${m} failed:`, err instanceof Error ? err.message : err);
    return 0;
  })));
  METRICS.forEach((m, i) => { out[m] = results[i] ?? 0; });
  return out;
}

export async function readCounter(dataId: string, metric: string, now = new Date()): Promise<number> {
  const row = await queryOne<{ value: string | number }>(
    `SELECT value FROM usage_counters WHERE user_id = $1 AND metric = $2 AND period_start = $3::date`,
    [dataId, metric, monthStart(now)]
  );
  return n(row?.value);
}

/** Add `delta` to this month's counter (single atomic upsert). */
export async function recordUsage(dataId: string, metric: string, delta = 1, now = new Date()): Promise<void> {
  if (!Number.isFinite(delta) || delta === 0) return;
  await query(
    `INSERT INTO usage_counters (user_id, metric, period_start, value) VALUES ($1, $2, $3::date, $4)
     ON CONFLICT (user_id, metric, period_start) DO UPDATE SET value = usage_counters.value + EXCLUDED.value, updated_at = NOW()`,
    [dataId, metric, monthStart(now), Math.trunc(delta)]
  );
}

/** Sampled API-call counting: 1 in `rate` calls writes `rate` (never throws). */
export function recordApiCallSampled(dataId: string, rate = 10, rand = Math.random): void {
  if (rand() * rate >= 1) return;
  void recordUsage(dataId, "api_calls", rate).catch(() => undefined);
}
