/** Pure alert-rule logic (client-safe: no DB imports). */

export const ALERT_OPS = ["gt", "gte", "lt", "lte", "eq"] as const;
export type AlertOp = (typeof ALERT_OPS)[number];

export interface AlertCondition {
  metric: string;
  op: AlertOp;
  threshold: number;
  window_min: number;
}

export interface RuleLike {
  condition: AlertCondition;
  enabled: boolean;
  last_fired_at: string | Date | null;
  cooldown_min: number;
}

export interface Evaluation {
  breached: boolean;
  value: number | null;
}

export function compare(op: AlertOp, value: number, threshold: number): boolean {
  switch (op) {
    case "gt": return value > threshold;
    case "gte": return value >= threshold;
    case "lt": return value < threshold;
    case "lte": return value <= threshold;
    case "eq": return value === threshold;
  }
}

/** `sample` maps metric name -> value measured over the rule's own window (null = unavailable). */
export function evaluateRule(rule: Pick<RuleLike, "condition">, sample: Record<string, number | null | undefined>): Evaluation {
  const v = sample[rule.condition.metric];
  if (v === null || v === undefined || !Number.isFinite(v)) return { breached: false, value: null };
  return { breached: compare(rule.condition.op, v, rule.condition.threshold), value: v };
}

/** True when a notification may be sent now (never fired, or the cooldown elapsed). */
export function cooldownElapsed(rule: Pick<RuleLike, "last_fired_at" | "cooldown_min">, now: Date = new Date()): boolean {
  if (!rule.last_fired_at) return true;
  const last = new Date(rule.last_fired_at).getTime();
  if (!Number.isFinite(last)) return true;
  return now.getTime() - last >= Math.max(0, rule.cooldown_min) * 60_000;
}

export function parseCondition(raw: string | null | undefined): AlertCondition | null {
  try {
    const c = JSON.parse(raw ?? "null") as Partial<AlertCondition> | null;
    if (!c || typeof c.metric !== "string" || !(ALERT_OPS as readonly string[]).includes(c.op as string)) return null;
    const threshold = Number(c.threshold);
    if (!Number.isFinite(threshold)) return null;
    const win = Number(c.window_min);
    return { metric: c.metric, op: c.op as AlertOp, threshold, window_min: Number.isFinite(win) && win > 0 ? Math.min(win, 10_080) : 60 };
  } catch {
    return null;
  }
}

export interface MetricDef { key: string; label: string; unit: string; scope: "org" | "platform"; windowed: boolean }

export const METRICS: readonly MetricDef[] = [
  { key: "outbox_failed", label: "Failed notifications", unit: "count", scope: "org", windowed: true },
  { key: "sla_breaches_open", label: "Open SLA breaches", unit: "count", scope: "org", windowed: false },
  { key: "webhook_dead", label: "Dead webhook deliveries", unit: "count", scope: "org", windowed: true },
  { key: "accounting_sync_errors", label: "Failed accounting syncs", unit: "count", scope: "org", windowed: true },
  { key: "invoices_past_due", label: "Past-due invoices", unit: "count", scope: "org", windowed: false },
  { key: "ai_budget_pct", label: "AI budget used", unit: "%", scope: "org", windowed: false },
  { key: "agent_failure_rate", label: "Agent job failure rate", unit: "%", scope: "org", windowed: true },
  { key: "sync_errors", label: "Mail / calendar accounts in error", unit: "count", scope: "org", windowed: false },
  { key: "cron_stale", label: "Minutes since last cron tick", unit: "min", scope: "platform", windowed: false },
  { key: "jobs_queued", label: "Agent jobs queued (all workspaces)", unit: "count", scope: "platform", windowed: false },
  { key: "outbox_failed_all", label: "Failed notifications (all workspaces)", unit: "count", scope: "platform", windowed: true },
];

export interface DefaultRule { key: string; name: string; condition: AlertCondition; enabled: boolean; cooldown_min: number }

export const DEFAULT_RULES: readonly DefaultRule[] = [
  { key: "outbox_failed", name: "Notification failures", condition: { metric: "outbox_failed", op: "gt", threshold: 20, window_min: 60 }, enabled: true, cooldown_min: 60 },
  { key: "webhook_dead", name: "Dead webhook deliveries", condition: { metric: "webhook_dead", op: "gt", threshold: 5, window_min: 1440 }, enabled: true, cooldown_min: 240 },
  { key: "ai_budget", name: "AI budget nearly used", condition: { metric: "ai_budget_pct", op: "gte", threshold: 90, window_min: 60 }, enabled: true, cooldown_min: 720 },
  { key: "sla_breaches", name: "Open SLA breaches", condition: { metric: "sla_breaches_open", op: "gt", threshold: 0, window_min: 60 }, enabled: false, cooldown_min: 240 },
  { key: "accounting_errors", name: "Accounting sync errors", condition: { metric: "accounting_sync_errors", op: "gt", threshold: 3, window_min: 1440 }, enabled: false, cooldown_min: 240 },
  { key: "past_due_invoices", name: "Past-due invoices", condition: { metric: "invoices_past_due", op: "gt", threshold: 0, window_min: 60 }, enabled: false, cooldown_min: 1440 },
  { key: "agent_failures", name: "Agent failure rate", condition: { metric: "agent_failure_rate", op: "gte", threshold: 25, window_min: 360 }, enabled: false, cooldown_min: 240 },
  { key: "sync_errors", name: "Mail / calendar sync errors", condition: { metric: "sync_errors", op: "gt", threshold: 0, window_min: 60 }, enabled: false, cooldown_min: 480 },
];

export const PLATFORM_DEFAULT_RULES: readonly DefaultRule[] = [
  { key: "cron_stale", name: "Cron not ticking", condition: { metric: "cron_stale", op: "gt", threshold: 10, window_min: 10 }, enabled: true, cooldown_min: 30 },
  { key: "jobs_backlog", name: "Agent job backlog", condition: { metric: "jobs_queued", op: "gt", threshold: 500, window_min: 10 }, enabled: false, cooldown_min: 60 },
];

export function describeCondition(c: AlertCondition): string {
  const sym = { gt: ">", gte: "≥", lt: "<", lte: "≤", eq: "=" }[c.op];
  const def = METRICS.find((m) => m.key === c.metric);
  return `${def?.label ?? c.metric} ${sym} ${c.threshold}${def?.unit === "%" ? "%" : ""}${def?.windowed ? ` in ${c.window_min} min` : ""}`;
}
