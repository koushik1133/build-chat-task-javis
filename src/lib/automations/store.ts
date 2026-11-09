import { randomUUID } from "crypto";
import { query, queryOne } from "@/lib/dsql";
import { isLegacyRow, legacyToV2, type LegacyRow } from "./legacy";
import { getTemplate } from "./templates";
import type { AutomationDTO, AutomationDefinition, AutomationRunDTO, ConditionNode, RunContext, Step, StepResult, TriggerConfig, TriggerType } from "./types";

/** Persistence for automations v2 + run history. All queries are scoped by user_id (= org data id). */

export interface AutomationRow extends LegacyRow {
  user_id: string;
  trigger_type: string | null;
  trigger_config: string | null;
  conditions: string | null;
  steps: string | null;
  version: number | null;
  enabled: boolean | null;
  autonomy: string | null;
  description: string | null;
  template_key: string | null;
  run_count: number | null;
  error_count: number | null;
  last_run_at: string | Date | null;
  last_error: string | null;
  created_at: string | Date;
  updated_at: string | Date | null;
}

export const AUTOMATION_COLS = `id::text AS id, user_id, name, trigger_event, action_type, kanban_label, action_config, schedule_time, schedule_timezone, schedule_days, status,
  trigger_type, trigger_config, conditions, steps, version, enabled, autonomy, description, template_key, run_count, error_count, last_run_at, last_error, created_at, updated_at`;

const iso = (v: string | Date | null | undefined): string | null => (v == null ? null : v instanceof Date ? v.toISOString() : String(v));

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** The executable definition of a row: v2 columns, or the legacy adapter. */
export function definitionOf(row: AutomationRow): AutomationDefinition & { legacy: boolean } {
  if (isLegacyRow(row)) return { ...legacyToV2(row), legacy: true };
  return {
    name: row.name,
    description: row.description,
    trigger_type: (row.trigger_type as TriggerType) ?? "manual",
    trigger_config: parseJson<TriggerConfig>(row.trigger_config, {}),
    conditions: parseJson<ConditionNode | null>(row.conditions, null),
    steps: parseJson<Step[]>(row.steps, []),
    autonomy: row.autonomy === "auto" ? "auto" : "approve",
    enabled: row.enabled ?? row.status === "active",
    legacy: false,
  };
}

export function toAutomationDTO(row: AutomationRow): AutomationDTO {
  const def = definitionOf(row);
  return {
    id: row.id,
    ...def,
    version: Number(row.version ?? 1),
    template_key: row.template_key,
    run_count: Number(row.run_count ?? 0),
    error_count: Number(row.error_count ?? 0),
    last_run_at: iso(row.last_run_at),
    last_error: row.last_error,
    created_at: iso(row.created_at) ?? "",
    updated_at: iso(row.updated_at),
  };
}

/** Marker returned in place of a stored secret for callers who may read but not edit automations. */
export const REDACTED_SECRET = "••••••••";

/**
 * Strip the inbound webhook token and outbound webhook signing secrets from a
 * DTO. Viewers (agents: view) must not learn credentials that let them fire
 * the automation from outside or forge signed deliveries.
 */
export function redactAutomationSecrets(dto: AutomationDTO): AutomationDTO {
  const trigger_config: TriggerConfig = dto.trigger_config.webhook ? { ...dto.trigger_config, webhook: { token: REDACTED_SECRET } } : dto.trigger_config;
  const steps = dto.steps.map((s) => (s.kind === "webhook" && s.config.secret ? { ...s, config: { ...s.config, secret: REDACTED_SECRET } } : s));
  return { ...dto, trigger_config, steps };
}

export async function listAutomations(dataId: string, opts: { triggerType?: TriggerType | null; enabled?: boolean | null; limit?: number } = {}): Promise<AutomationRow[]> {
  const params: unknown[] = [dataId];
  let where = "user_id = $1";
  if (opts.triggerType) {
    params.push(opts.triggerType);
    where += ` AND trigger_type = $${params.length}`;
  }
  if (opts.enabled != null) {
    params.push(opts.enabled);
    where += ` AND COALESCE(enabled, status = 'active') = $${params.length}`;
  }
  params.push(Math.min(Math.max(opts.limit ?? 200, 1), 500));
  return query<AutomationRow>(`SELECT ${AUTOMATION_COLS} FROM automations WHERE ${where} ORDER BY created_at DESC LIMIT $${params.length}`, params);
}

export async function getAutomation(dataId: string, id: string): Promise<AutomationRow | null> {
  return queryOne<AutomationRow>(`SELECT ${AUTOMATION_COLS} FROM automations WHERE id::text = $1 AND user_id = $2`, [id, dataId]);
}

/** Legacy columns are filled with a readable summary so old code paths (marketplace scrub, cron) keep working. */
function legacyColumnsFor(def: AutomationDefinition): { trigger_event: string; action_type: string; schedule_time: string | null; schedule_timezone: string | null; schedule_days: string | null } {
  const first = def.steps[0];
  const action = first ? (first.kind === "tool" ? first.config.tool : `v2:${first.kind}`) : "v2:none";
  const trigger = def.trigger_type === "schedule" ? "Scheduled (Daily)" : def.trigger_type === "event" ? (def.trigger_config.event_type ?? "event") : def.trigger_type;
  return {
    trigger_event: trigger,
    action_type: action,
    schedule_time: def.trigger_config.schedule?.time ?? null,
    schedule_timezone: def.trigger_config.schedule?.timezone ?? null,
    schedule_days: def.trigger_config.schedule?.days ?? null,
  };
}

export async function createAutomation(dataId: string, def: AutomationDefinition, opts: { templateKey?: string | null } = {}): Promise<AutomationRow> {
  const legacy = legacyColumnsFor(def);
  const row = await queryOne<AutomationRow>(
    `INSERT INTO automations (user_id, name, trigger_event, action_type, kanban_label, action_config, schedule_time, schedule_timezone, schedule_days, status, run_count,
       trigger_type, trigger_config, conditions, steps, version, enabled, autonomy, description, template_key, error_count, updated_at)
     VALUES ($1, $2, $3, $4, NULL, '{}', $5, $6, $7, $8, 0, $9, $10, $11, $12, 1, $13, $14, $15, $16, 0, NOW())
     RETURNING ${AUTOMATION_COLS}`,
    [
      dataId,
      def.name,
      legacy.trigger_event,
      legacy.action_type,
      legacy.schedule_time,
      legacy.schedule_timezone,
      legacy.schedule_days,
      def.enabled ? "active" : "paused",
      def.trigger_type,
      JSON.stringify(def.trigger_config ?? {}),
      def.conditions ? JSON.stringify(def.conditions) : null,
      JSON.stringify(def.steps),
      def.enabled,
      def.autonomy,
      def.description ?? null,
      opts.templateKey ?? null,
    ]
  );
  if (!row) throw new Error("insert returned no row");
  return row;
}

/** Replace the definition (full v2 shape). Bumps `version`; converts a legacy row on first save. */
export async function saveAutomation(dataId: string, id: string, def: AutomationDefinition): Promise<AutomationRow | null> {
  const legacy = legacyColumnsFor(def);
  return queryOne<AutomationRow>(
    `UPDATE automations SET name = $3, trigger_event = $4, action_type = $5, schedule_time = $6, schedule_timezone = $7, schedule_days = $8, status = $9,
       trigger_type = $10, trigger_config = $11, conditions = $12, steps = $13, enabled = $14, autonomy = $15, description = $16,
       version = COALESCE(version, 0) + 1, updated_at = NOW()
     WHERE id::text = $1 AND user_id = $2 RETURNING ${AUTOMATION_COLS}`,
    [
      id,
      dataId,
      def.name,
      legacy.trigger_event,
      legacy.action_type,
      legacy.schedule_time,
      legacy.schedule_timezone,
      legacy.schedule_days,
      def.enabled ? "active" : "paused",
      def.trigger_type,
      JSON.stringify(def.trigger_config ?? {}),
      def.conditions ? JSON.stringify(def.conditions) : null,
      JSON.stringify(def.steps),
      def.enabled,
      def.autonomy,
      def.description ?? null,
    ]
  );
}

export async function setEnabled(dataId: string, id: string, enabled: boolean): Promise<AutomationRow | null> {
  return queryOne<AutomationRow>(
    `UPDATE automations SET enabled = $3, status = $4, updated_at = NOW() WHERE id::text = $1 AND user_id = $2 RETURNING ${AUTOMATION_COLS}`,
    [id, dataId, enabled, enabled ? "active" : "paused"]
  );
}

export async function deleteAutomation(dataId: string, id: string): Promise<boolean> {
  const row = await queryOne<{ id: string }>(`DELETE FROM automations WHERE id::text = $1 AND user_id = $2 RETURNING id::text AS id`, [id, dataId]);
  if (row) await query(`DELETE FROM automation_runs WHERE automation_id = $1 AND user_id = $2`, [id, dataId]).catch(() => undefined);
  return Boolean(row);
}

/** One-time conversion of legacy rows for an org: persists the adapter output so the editor can save them. */
export async function migrateLegacyAutomations(dataId: string): Promise<number> {
  const rows = await query<AutomationRow>(`SELECT ${AUTOMATION_COLS} FROM automations WHERE user_id = $1 AND (trigger_type IS NULL OR steps IS NULL)`, [dataId]);
  let n = 0;
  for (const row of rows) {
    const def = legacyToV2(row);
    await query(
      `UPDATE automations SET trigger_type = $3, trigger_config = $4, conditions = $5, steps = $6, enabled = $7, autonomy = $8, version = COALESCE(version, 1), error_count = COALESCE(error_count, 0), updated_at = NOW()
       WHERE id::text = $1 AND user_id = $2 AND (trigger_type IS NULL OR steps IS NULL)`,
      [row.id, dataId, def.trigger_type, JSON.stringify(def.trigger_config), def.conditions ? JSON.stringify(def.conditions) : null, JSON.stringify(def.steps), def.enabled, def.autonomy]
    );
    n++;
  }
  return n;
}

/* ─── runs ─────────────────────────────────────────────────────────────── */

export interface RunRow {
  id: string;
  user_id: string;
  automation_id: string;
  trigger_event_id: string | null;
  status: string;
  context: string | null;
  step_results: string | null;
  step_index: number | null;
  approval_id: string | null;
  error: string | null;
  attempt: number | null;
  started_at: string | Date | null;
  finished_at: string | Date | null;
  resume_at: string | Date | null;
  created_at: string | Date;
  automation_name?: string | null;
}

export const RUN_COLS = `r.id, r.user_id, r.automation_id, r.trigger_event_id, r.status, r.context, r.step_results, r.step_index, r.approval_id, r.error, r.attempt, r.started_at, r.finished_at, r.resume_at, r.created_at`;

export function toRunDTO(r: RunRow): AutomationRunDTO {
  return {
    id: r.id,
    automation_id: r.automation_id,
    automation_name: r.automation_name ?? null,
    trigger_event_id: r.trigger_event_id,
    status: r.status as AutomationRunDTO["status"],
    context: parseJson<RunContext | null>(r.context, null),
    step_results: parseJson<StepResult[]>(r.step_results, []),
    step_index: Number(r.step_index ?? 0),
    approval_id: r.approval_id,
    error: r.error,
    attempt: Number(r.attempt ?? 1),
    started_at: iso(r.started_at),
    finished_at: iso(r.finished_at),
    resume_at: iso(r.resume_at),
    created_at: iso(r.created_at) ?? "",
  };
}

/** Insert a queued run; returns null when a run for (automation, event) already exists (idempotency). */
export async function enqueueRun(dataId: string, automationId: string, context: RunContext, triggerEventId: string | null): Promise<string | null> {
  if (triggerEventId) {
    const dup = await queryOne<{ id: string }>(`SELECT id FROM automation_runs WHERE automation_id = $1 AND trigger_event_id = $2 LIMIT 1`, [automationId, triggerEventId]);
    if (dup) return null;
  }
  const id = randomUUID();
  try {
    await query(
      `INSERT INTO automation_runs (id, user_id, automation_id, trigger_event_id, status, context, step_results, step_index, attempt)
       VALUES ($1, $2, $3, $4, 'queued', $5, '[]', 0, 1)`,
      [id, dataId, automationId, triggerEventId, JSON.stringify(context)]
    );
  } catch (err) {
    // Unique (automation_id, trigger_event_id) race: another tick got there first.
    if (err instanceof Error && /unique|duplicate/i.test(err.message)) return null;
    throw err;
  }
  return id;
}

export async function listRuns(dataId: string, opts: { automationId?: string | null; status?: string | null; limit?: number; before?: string | null } = {}): Promise<RunRow[]> {
  const params: unknown[] = [dataId];
  let where = "r.user_id = $1";
  if (opts.automationId) {
    params.push(opts.automationId);
    where += ` AND r.automation_id = $${params.length}`;
  }
  if (opts.status) {
    params.push(opts.status);
    where += ` AND r.status = $${params.length}`;
  }
  if (opts.before) {
    params.push(opts.before);
    where += ` AND r.created_at < $${params.length}`;
  }
  params.push(Math.min(Math.max(opts.limit ?? 50, 1), 200));
  return query<RunRow>(
    `SELECT ${RUN_COLS}, a.name AS automation_name FROM automation_runs r LEFT JOIN automations a ON a.id::text = r.automation_id WHERE ${where} ORDER BY r.created_at DESC LIMIT $${params.length}`,
    params
  );
}

export async function getRun(dataId: string, runId: string): Promise<RunRow | null> {
  return queryOne<RunRow>(
    `SELECT ${RUN_COLS}, a.name AS automation_name FROM automation_runs r LEFT JOIN automations a ON a.id::text = r.automation_id WHERE r.id = $1 AND r.user_id = $2`,
    [runId, dataId]
  );
}

/** Reset a finished run so the next `runQueued` executes it again from the first step. */
export async function requeueRun(dataId: string, runId: string): Promise<RunRow | null> {
  return queryOne<RunRow>(
    `UPDATE automation_runs r SET status = 'queued', step_index = 0, step_results = '[]', error = NULL, approval_id = NULL, resume_at = NULL, started_at = NULL, finished_at = NULL, attempt = COALESCE(attempt, 1) + 1
     WHERE r.id = $1 AND r.user_id = $2 AND r.status IN ('done', 'failed', 'skipped') RETURNING ${RUN_COLS}`,
    [runId, dataId]
  );
}

export async function runStats(dataId: string): Promise<Record<string, { total: number; failed: number; waiting: number }>> {
  const rows = await query<{ automation_id: string; status: string; n: string | number }>(
    `SELECT automation_id, status, COUNT(*) AS n FROM automation_runs WHERE user_id = $1 GROUP BY automation_id, status`,
    [dataId]
  ).catch(() => []);
  const out: Record<string, { total: number; failed: number; waiting: number }> = {};
  for (const r of rows) {
    const s = (out[r.automation_id] ??= { total: 0, failed: 0, waiting: 0 });
    const n = Number(r.n);
    s.total += n;
    if (r.status === "failed") s.failed += n;
    if (r.status === "waiting") s.waiting += n;
  }
  return out;
}

/** Public-API view of a run: no org id, no full context (events are reachable through /v1/events). */
export function toPublicRunDTO(r: RunRow): Omit<AutomationRunDTO, "context" | "automation_name"> {
  const dto = toRunDTO(r);
  return {
    id: dto.id,
    automation_id: dto.automation_id,
    trigger_event_id: dto.trigger_event_id,
    status: dto.status,
    step_results: dto.step_results,
    step_index: dto.step_index,
    approval_id: dto.approval_id,
    error: dto.error,
    attempt: dto.attempt,
    started_at: dto.started_at,
    finished_at: dto.finished_at,
    resume_at: dto.resume_at,
    created_at: dto.created_at,
  };
}

/* ─── templates ────────────────────────────────────────────────────────── */

/**
 * Install a ready-made template as a paused automation. When the template
 * needs a tool that is not registered (optional module), the dependent step
 * is swapped for a `tasks.create` step so the workflow still does something useful.
 */
export async function installTemplate(dataId: string, key: string, opts: { toolExists?: (name: string) => boolean } = {}): Promise<{ row: AutomationRow; swapped: string | null }> {
  const tpl = getTemplate(key);
  if (!tpl) throw new Error(`unknown template ${key}`);
  const def: AutomationDefinition = JSON.parse(JSON.stringify(tpl.definition)) as AutomationDefinition;
  let swapped: string | null = null;
  if (tpl.requires_tool && tpl.fallback_step_id) {
    const exists = opts.toolExists ? opts.toolExists(tpl.requires_tool) : (await import("@/lib/agents/registry")).getTool(tpl.requires_tool) !== undefined;
    if (!exists) {
      def.steps = def.steps.map((s) =>
        s.id === tpl.fallback_step_id
          ? { id: s.id, kind: "tool", name: `${s.name ?? s.id} (task)`, config: { tool: "tasks.create", input: { title: `${tpl.title}: {{entity.name ?? event.entity_id}}` } } }
          : s
      );
      swapped = tpl.requires_tool;
    }
  }
  const row = await createAutomation(dataId, def, { templateKey: key });
  return { row, swapped };
}
