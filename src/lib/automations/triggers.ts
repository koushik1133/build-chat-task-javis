import { randomUUID } from "crypto";
import { query, queryOne } from "@/lib/dsql";
import { getLocalNow, isScheduleDue } from "@/lib/automation-scheduler";
import { evaluateConditions, getPath } from "./conditions";
import { definitionOf, enqueueRun, listAutomations, type AutomationRow } from "./store";
import type { AutomationDefinition, RunContext, RunEvent, TriggerConfig } from "./types";

/**
 * Trigger side of the engine: turn `events` rows (cursor watermark), due
 * schedules, inbound webhooks and manual requests into queued
 * `automation_runs`. Execution happens in engine.ts (`runQueued`).
 */

const CURSOR_NAME = "events";

export interface EventRow {
  id: string;
  user_id: string;
  type: string;
  entity: string;
  entity_id: string;
  data: string | null;
  created_at: string | Date;
}

/* ─── matching ─────────────────────────────────────────────────────────── */

/** `*`, exact, or prefix wildcard (`invoice.*`). A comma list matches any entry. */
export function matchesEventType(pattern: string | undefined, eventType: string): boolean {
  if (!pattern) return false;
  for (const raw of pattern.split(",")) {
    const p = raw.trim();
    if (!p) continue;
    if (p === "*" || p === eventType) return true;
    if (p.endsWith(".*") && eventType.startsWith(p.slice(0, -1))) return true;
    if (p.endsWith("*") && eventType.startsWith(p.slice(0, -1))) return true;
  }
  return false;
}

export function matchesFilter(filter: TriggerConfig["filter"], data: Record<string, unknown>): boolean {
  if (!filter) return true;
  for (const [k, v] of Object.entries(filter)) {
    const actual = getPath(data, k);
    if (v === null ? actual != null : String(actual ?? "") !== String(v)) return false;
  }
  return true;
}

/* ─── entity loader ────────────────────────────────────────────────────── */

/** event.entity (or type prefix) → table. Whitelist only; never interpolate user input into SQL. */
const ENTITY_TABLES: Record<string, string> = {
  crm_contact: "crm_contacts",
  crm_contacts: "crm_contacts",
  contact: "crm_contacts",
  crm: "crm_contacts",
  site_lead: "site_leads",
  lead: "site_leads",
  invoice: "invoices",
  invoices: "invoices",
  quote: "quotes",
  booking: "bookings",
  ticket: "tickets",
  record: "records",
  task: "tasks",
  tasks: "tasks",
  product: "products",
  expense: "expenses",
  dsr_request: "dsr_requests",
  production_task: "production_tasks",
  card: "production_tasks",
  production: "production_tasks",
  social_post: "social_posts",
  chat_session: "webchat_sessions",
  webchat: "webchat_sessions",
  credit_note: "credit_notes",
  marketplace_install: "marketplace_installs",
  marketplace: "marketplace_installs",
};

export function entityTableFor(evt: Pick<RunEvent, "type" | "entity">): string | null {
  return ENTITY_TABLES[evt.entity] ?? ENTITY_TABLES[evt.type.split(".")[0]] ?? null;
}

const missingTables = new Set<string>();

export async function loadEntity(dataId: string, evt: Pick<RunEvent, "type" | "entity" | "entity_id">): Promise<Record<string, unknown> | null> {
  const table = entityTableFor(evt);
  if (!table || missingTables.has(table) || !evt.entity_id || evt.entity_id === "sample_id") return null;
  try {
    const row = await queryOne<Record<string, unknown>>(`SELECT * FROM ${table} WHERE id::text = $1 AND user_id = $2`, [evt.entity_id, dataId]);
    if (!row) return null;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row)) {
      if (k === "user_id") continue;
      out[k] = v instanceof Date ? v.toISOString() : v;
    }
    return out;
  } catch (err) {
    if (err instanceof Error && /does not exist/i.test(err.message)) missingTables.add(table);
    return null;
  }
}

/* ─── context ──────────────────────────────────────────────────────────── */

function parseData(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const v: unknown = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function toRunEvent(evt: EventRow): RunEvent {
  return {
    id: evt.id,
    type: evt.type,
    entity: evt.entity,
    entity_id: evt.entity_id,
    data: parseData(evt.data),
    created_at: evt.created_at instanceof Date ? evt.created_at.toISOString() : String(evt.created_at),
  };
}

const orgNameCache = new Map<string, string | null>();
async function orgName(dataId: string): Promise<string | null> {
  if (orgNameCache.has(dataId)) return orgNameCache.get(dataId) ?? null;
  const row = await queryOne<{ name: string }>(`SELECT name FROM organizations WHERE owner_user_id = $1 ORDER BY created_at ASC LIMIT 1`, [dataId]).catch(() => null);
  orgNameCache.set(dataId, row?.name ?? null);
  return row?.name ?? null;
}

export async function buildContext(dataId: string, automation: { id: string; name: string }, event: RunEvent, entity?: Record<string, unknown> | null): Promise<RunContext> {
  const ent = entity === undefined ? await loadEntity(dataId, event) : entity;
  return {
    event,
    entity: ent,
    org: { id: dataId, name: await orgName(dataId) },
    automation: { id: automation.id, name: automation.name },
    steps: {},
    now: new Date().toISOString(),
  };
}

/** Synthetic event for manual / schedule / webhook triggers. */
export function syntheticEvent(type: string, data: Record<string, unknown> = {}, entity = "automation", entityId = "manual"): RunEvent {
  return { id: `synthetic_${randomUUID()}`, type, entity, entity_id: entityId, data, created_at: new Date().toISOString() };
}

/* ─── fan-out ──────────────────────────────────────────────────────────── */

export interface FanOutResult {
  scanned: number;
  matched: number;
  queued: number;
}

/** Decide whether one automation fires for one event (pure, exported for tests). */
export function triggerMatches(def: AutomationDefinition, event: RunEvent, automationId: string): boolean {
  if (!def.enabled || def.trigger_type !== "event") return false;
  if (!matchesEventType(def.trigger_config.event_type, event.type)) return false;
  // Never let an automation react to its own run events (infinite loop guard).
  if (event.type.startsWith("automation.") && String(event.data.automation_id ?? "") === automationId) return false;
  return matchesFilter(def.trigger_config.filter, event.data);
}

/** Queue runs for one event. `candidates` lets the cursor loop reuse the per-user list. */
export async function fanOutEvent(evt: EventRow, candidates?: AutomationRow[]): Promise<{ matched: number; queued: number }> {
  const rows = candidates ?? (await listAutomations(evt.user_id, { triggerType: "event", enabled: true }));
  const event = toRunEvent(evt);
  let matched = 0;
  let queued = 0;
  let entity: Record<string, unknown> | null | undefined;
  for (const row of rows) {
    const def = definitionOf(row);
    if (!triggerMatches(def, event, row.id)) continue;
    if (entity === undefined) entity = await loadEntity(evt.user_id, event);
    const context = await buildContext(evt.user_id, { id: row.id, name: def.name }, event, entity);
    if (!evaluateConditions(def.conditions, context)) continue;
    matched++;
    const id = await enqueueRun(evt.user_id, row.id, context, evt.id);
    if (id) queued++;
  }
  return { matched, queued };
}

/**
 * Cursor loop over `events` (same watermark pattern as webhooks). On first run
 * the cursor starts at "now" so history is not replayed.
 */
export async function fanOutEvents(limit = 200): Promise<FanOutResult> {
  const cur = await queryOne<{ last_event_at: string | Date | null }>(`SELECT last_event_at FROM automation_cursors WHERE name = $1`, [CURSOR_NAME]);
  if (!cur) {
    await query(`INSERT INTO automation_cursors (name, last_event_at, last_event_id, updated_at) VALUES ($1, NOW(), '', NOW())`, [CURSOR_NAME]).catch(() => undefined);
    return { scanned: 0, matched: 0, queued: 0 };
  }
  const events = await query<EventRow>(
    `SELECT e.id, e.user_id, e.type, e.entity, e.entity_id, e.data, e.created_at
       FROM events e, automation_cursors c
      WHERE c.name = $1
        AND (e.created_at > COALESCE(c.last_event_at, 'epoch'::timestamptz)
             OR (e.created_at = c.last_event_at AND e.id > COALESCE(c.last_event_id, '')))
      ORDER BY e.created_at ASC, e.id ASC LIMIT $2`,
    [CURSOR_NAME, Math.min(Math.max(limit, 1), 1000)]
  );
  if (events.length === 0) return { scanned: 0, matched: 0, queued: 0 };

  const byUser = new Map<string, AutomationRow[]>();
  let matched = 0;
  let queued = 0;
  for (const evt of events) {
    let rows = byUser.get(evt.user_id);
    if (!rows) {
      rows = await listAutomations(evt.user_id, { triggerType: "event", enabled: true }).catch(() => []);
      byUser.set(evt.user_id, rows);
    }
    if (rows.length === 0) continue;
    try {
      const r = await fanOutEvent(evt, rows);
      matched += r.matched;
      queued += r.queued;
    } catch (err) {
      console.error(`[automations] fan-out failed for event ${evt.id}:`, err);
    }
  }
  const last = events[events.length - 1];
  await query(`UPDATE automation_cursors SET last_event_at = (SELECT created_at FROM events WHERE id = $2), last_event_id = $2, updated_at = NOW() WHERE name = $1`, [CURSOR_NAME, last.id]);
  return { scanned: events.length, matched, queued };
}

/* ─── schedules ────────────────────────────────────────────────────────── */

/** Queue a run for every v2 schedule automation whose local time is due (claims via last_scheduled_date). */
export async function fireDueSchedules(): Promise<{ checked: number; queued: number }> {
  const rows = await query<AutomationRow & { last_scheduled_date: string | null }>(
    `SELECT ${"id::text AS id, user_id, name, trigger_config, conditions, steps, enabled, autonomy, status, last_scheduled_date, trigger_type, trigger_event, action_type, kanban_label, action_config, schedule_time, schedule_timezone, schedule_days, version, description, template_key, run_count, error_count, last_run_at, last_error, created_at, updated_at"}
       FROM automations WHERE trigger_type = 'schedule' AND enabled = TRUE`
  ).catch(() => []);
  let queued = 0;
  for (const row of rows) {
    const def = definitionOf(row);
    const sch = def.trigger_config.schedule;
    if (!sch) continue;
    const local = getLocalNow(sch.timezone);
    if (!isScheduleDue({ schedule_time: sch.time, schedule_timezone: sch.timezone, schedule_days: sch.days, last_scheduled_date: row.last_scheduled_date }, local)) continue;
    const claimed = await queryOne<{ id: string }>(
      `UPDATE automations SET last_scheduled_date = $1 WHERE id::text = $2 AND (last_scheduled_date IS DISTINCT FROM $1) RETURNING id::text AS id`,
      [local.date, row.id]
    ).catch(() => null);
    if (!claimed) continue;
    const event = syntheticEvent("automation.schedule", { date: local.date, time: local.time, timezone: sch.timezone }, "automation", row.id);
    const context = await buildContext(row.user_id, { id: row.id, name: def.name }, event, null);
    if (!evaluateConditions(def.conditions, context)) continue;
    if (await enqueueRun(row.user_id, row.id, context, null)) queued++;
  }
  return { checked: rows.length, queued };
}

/* ─── manual + webhook ─────────────────────────────────────────────────── */

/** Queue a manual run (optionally against a stored event id or an inline sample payload). */
export async function enqueueManualRun(dataId: string, row: AutomationRow, opts: { eventId?: string | null; event?: RunEvent | null } = {}): Promise<{ runId: string; context: RunContext }> {
  const def = definitionOf(row);
  let event: RunEvent | null = opts.event ?? null;
  if (!event && opts.eventId) {
    const e = await queryOne<EventRow>(`SELECT id, user_id, type, entity, entity_id, data, created_at FROM events WHERE id = $1 AND user_id = $2`, [opts.eventId, dataId]);
    if (e) event = toRunEvent(e);
  }
  if (!event) event = syntheticEvent("automation.manual", { requested_at: new Date().toISOString() }, "automation", row.id);
  const context = await buildContext(dataId, { id: row.id, name: def.name }, event);
  const runId = await enqueueRun(dataId, row.id, context, null);
  if (!runId) throw new Error("could not queue run");
  return { runId, context };
}

/** Inbound webhook trigger: body becomes `event.data`. Returns null when the token does not match. */
export async function enqueueWebhookRun(row: AutomationRow, token: string | null, body: Record<string, unknown>): Promise<string | null> {
  const def = definitionOf(row);
  if (def.trigger_type !== "webhook" || !def.enabled) return null;
  const expected = def.trigger_config.webhook?.token;
  if (!expected || !token || token.length !== expected.length || !timingSafeEqualStr(token, expected)) return null;
  const event = syntheticEvent("automation.webhook", body, "automation", row.id);
  const context = await buildContext(row.user_id, { id: row.id, name: def.name }, event, null);
  if (!evaluateConditions(def.conditions, context)) return null;
  return enqueueRun(row.user_id, row.id, context, null);
}

function timingSafeEqualStr(a: string, b: string): boolean {
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
