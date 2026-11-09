import type { AutomationDTO, AutomationRunDTO, RunContext, RunEvent, RunStatus, Step, StepKind } from "@/lib/automations/types";
import type { Tone } from "@/components/ui/pill";

/** Client-side helpers for the automations builder (no DB imports). */

export interface CatalogEvent {
  type: string;
  entity: string;
  sample: RunEvent;
  recent_count: number;
}
export interface CatalogTool {
  name: string;
  module: string;
  description: string;
  scope: "read" | "write";
  schema: JsonSchema;
  gated: boolean;
}
export interface JsonSchema {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  enum?: unknown[];
  items?: JsonSchema;
  description?: string;
  nullable?: boolean;
  anyOf?: JsonSchema[];
}
export interface Catalog {
  events: CatalogEvent[];
  tools: CatalogTool[];
  condition_ops: { op: string; label: string }[];
  step_kinds: { kind: StepKind; label: string }[];
  agents: { id: string; name: string; role: string }[];
  context_paths: string[];
}

export type AutomationWithStats = AutomationDTO & { stats: { total: number; failed: number; waiting: number } };

export const RUN_TONE: Record<RunStatus, Tone> = { queued: "neutral", running: "info", waiting: "warning", done: "success", failed: "danger", skipped: "neutral" };

export async function apiJson<T>(url: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  const res = await fetch(url, {
    ...rest,
    headers: { ...(json !== undefined ? { "content-type": "application/json" } : {}), ...(rest.headers ?? {}) },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
  return body;
}

/** Context the editor renders previews against: the picked sample event + a stand-in entity. */
export function previewContext(event: RunEvent | null, automation: { id: string; name: string }, entity: Record<string, unknown> | null = null): RunContext {
  return {
    event: event ?? { id: "evt_sample", type: "automation.manual", entity: "automation", entity_id: "sample_id", data: {}, created_at: new Date().toISOString() },
    entity,
    org: { id: "org_sample", name: "Your workspace" },
    automation,
    steps: {},
    now: new Date().toISOString(),
  };
}

export function newStepId(kind: StepKind, existing: Step[]): string {
  let i = existing.length + 1;
  let id = `${kind}_${i}`;
  const ids = new Set(existing.map((s) => s.id));
  while (ids.has(id)) id = `${kind}_${++i}`;
  return id;
}

export function defaultStep(kind: StepKind, existing: Step[]): Step {
  const id = newStepId(kind, existing);
  switch (kind) {
    case "tool":
      return { id, kind, config: { tool: "tasks.create", input: { title: "Follow up on {{event.type}} for {{event.entity_id}}" } } };
    case "delay":
      return { id, kind, config: { minutes: 60 } };
    case "branch":
      return { id, kind, config: { conditions: { all: [] }, then: null, else: "end" } };
    case "agent":
      return { id, kind, config: { agent_id: "", prompt: "An {{event.type}} event happened for {{event.entity}} {{event.entity_id}}. Decide what to do next." } };
    case "notify":
      return { id, kind, config: { channel: "in_app", to: "{{org.id}}", subject: "{{automation.name}}", body: "{{event.type}} on {{event.entity}} {{event.entity_id}}" } };
    case "webhook":
      return { id, kind, config: { url: "https://" } };
    case "approval":
      return { id, kind, config: { title: "Continue {{automation.name}}?" } };
  }
}

export function stepTitle(step: Step): string {
  if (step.name) return step.name;
  switch (step.kind) {
    case "tool":
      return step.config.tool;
    case "delay":
      return step.config.until ? `Wait until ${step.config.until}` : `Wait ${step.config.minutes ?? 0} min`;
    case "branch":
      return "Branch";
    case "agent":
      return "Ask an agent";
    case "notify":
      return `Send ${step.config.channel}`;
    case "webhook":
      return "Call webhook";
    case "approval":
      return step.config.title;
  }
}

export function describeTrigger(a: Pick<AutomationDTO, "trigger_type" | "trigger_config">): string {
  switch (a.trigger_type) {
    case "event":
      return a.trigger_config.event_type ?? "any event";
    case "schedule":
      return a.trigger_config.schedule ? `${a.trigger_config.schedule.days} at ${a.trigger_config.schedule.time} (${a.trigger_config.schedule.timezone})` : "schedule";
    case "webhook":
      return "inbound webhook";
    default:
      return "manual";
  }
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

export function runDuration(r: AutomationRunDTO): string {
  if (!r.started_at) return "—";
  const end = r.finished_at ? new Date(r.finished_at).getTime() : Date.now();
  const ms = end - new Date(r.started_at).getTime();
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** Empty v2 definition for /automations/new. */
export function blankAutomation(): AutomationDTO {
  return {
    id: "new",
    name: "",
    description: null,
    trigger_type: "event",
    trigger_config: { event_type: "" },
    conditions: null,
    steps: [],
    autonomy: "approve",
    enabled: false,
    version: 0,
    legacy: false,
    template_key: null,
    run_count: 0,
    error_count: 0,
    last_run_at: null,
    last_error: null,
    created_at: "",
    updated_at: null,
  };
}
