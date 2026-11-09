import { randomUUID } from "crypto";
import { query, queryOne, withRetry } from "@/lib/dsql";
import { DEFAULT_RULES, PLATFORM_DEFAULT_RULES, parseCondition, type AlertCondition, type DefaultRule } from "./evaluate";

export interface AlertRuleRow {
  id: string;
  user_id: string | null;
  key: string;
  name: string;
  condition: string;
  channel_ids: string;
  enabled: boolean;
  last_fired_at: string | null;
  last_eval_at: string | null;
  cooldown_min: number;
  created_at: string;
}

export interface AlertRuleView {
  id: string;
  key: string;
  name: string;
  condition: AlertCondition;
  channel_ids: string[];
  enabled: boolean;
  last_fired_at: string | null;
  cooldown_min: number;
}

export interface AlertEventRow {
  id: string;
  user_id: string | null;
  rule_id: string;
  fired_at: string;
  resolved_at: string | null;
  value: number | null;
  message: string | null;
  rule_name?: string | null;
}

export function parseChannels(raw: string | null | undefined): string[] {
  try {
    const v = JSON.parse(raw ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 10) : [];
  } catch {
    return [];
  }
}

export function toView(r: AlertRuleRow): AlertRuleView | null {
  const condition = parseCondition(r.condition);
  if (!condition) return null;
  return { id: r.id, key: r.key, name: r.name, condition, channel_ids: parseChannels(r.channel_ids), enabled: Boolean(r.enabled), last_fired_at: r.last_fired_at, cooldown_min: Number(r.cooldown_min) };
}

async function seed(userId: string | null, defs: readonly DefaultRule[]): Promise<void> {
  for (const d of defs) {
    const id = `dflt:${userId ?? "platform"}:${d.key}`;
    await withRetry(() =>
      query(
        `INSERT INTO alert_rules (id, user_id, key, name, condition, channel_ids, enabled, cooldown_min) VALUES ($1,$2,$3,$4,$5,'[]',$6,$7) ON CONFLICT (id) DO NOTHING`,
        [id, userId, d.key, d.name, JSON.stringify(d.condition), d.enabled, d.cooldown_min]
      )
    );
  }
}

/** Idempotent: creates the default rules (deterministic ids) the first time an org is seen. */
export async function ensureDefaultRules(dataId: string): Promise<void> {
  await seed(dataId, DEFAULT_RULES);
}

export async function ensurePlatformRules(): Promise<void> {
  await seed(null, PLATFORM_DEFAULT_RULES);
}

export async function listRules(dataId: string | null): Promise<AlertRuleView[]> {
  const rows = dataId === null
    ? await query<AlertRuleRow>(`SELECT * FROM alert_rules WHERE user_id IS NULL ORDER BY created_at, key`)
    : await query<AlertRuleRow>(`SELECT * FROM alert_rules WHERE user_id = $1 ORDER BY created_at, key`, [dataId]);
  return rows.map(toView).filter((v): v is AlertRuleView => v !== null);
}

export async function getRule(dataId: string, id: string): Promise<AlertRuleRow | null> {
  return queryOne<AlertRuleRow>(`SELECT * FROM alert_rules WHERE id = $1 AND user_id = $2`, [id, dataId]);
}

export async function listEvents(dataId: string | null, limit = 50): Promise<AlertEventRow[]> {
  const lim = Math.min(Math.max(limit, 1), 200);
  const sel = `SELECT e.id, e.user_id, e.rule_id, e.fired_at, e.resolved_at, e.value, e.message, r.name AS rule_name FROM alert_events e LEFT JOIN alert_rules r ON r.id = e.rule_id`;
  const rows = dataId === null
    ? await query<AlertEventRow>(`${sel} WHERE e.user_id IS NULL ORDER BY e.fired_at DESC LIMIT $1`, [lim])
    : await query<AlertEventRow>(`${sel} WHERE e.user_id = $1 ORDER BY e.fired_at DESC LIMIT $2`, [dataId, lim]);
  return rows.map((r) => ({ ...r, value: r.value === null ? null : Number(r.value) }));
}

export async function newEventId(): Promise<string> {
  return randomUUID();
}
