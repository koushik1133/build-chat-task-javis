import type { AutomationDefinition, ConditionNode, Step } from "./types";

/**
 * Adapter for pre-v2 automation rows (`trigger_event` + `action_type` +
 * `action_config`). Converting on read keeps every old automation visible and
 * executable through the new engine without a data migration; the one-time
 * `migrateLegacyAutomations()` in store.ts persists the converted shape.
 *
 * Client-safe (no DB).
 */

export interface LegacyRow {
  id: string;
  name: string;
  trigger_event: string | null;
  action_type: string | null;
  kanban_label: string | null;
  action_config: string | null;
  schedule_time: string | null;
  schedule_timezone: string | null;
  schedule_days: string | null;
  status: string | null;
}

export interface LegacyActionConfig {
  webhook_url?: string;
  url?: string;
  to?: string;
  subject?: string;
  message?: string;
  agent_id?: string;
  prompt?: string;
  deliver_via?: string[] | string;
  playbook_id?: string;
  entity_id?: string;
}

export const LEGACY_TRIGGER_SCHEDULED = "Scheduled (Daily)";
export const LEGACY_TRIGGER_KANBAN = "Kanban Card Moved";

export function parseLegacyConfig(raw: unknown): LegacyActionConfig {
  if (!raw) return {};
  if (typeof raw === "string") {
    try {
      const v: unknown = JSON.parse(raw);
      return v && typeof v === "object" ? (v as LegacyActionConfig) : {};
    } catch {
      return {};
    }
  }
  return typeof raw === "object" ? (raw as LegacyActionConfig) : {};
}

/** Legacy `{{task_title}}` placeholders → v2 context paths. */
export function convertLegacyTemplate(s: string | undefined, workflowName: string): string {
  if (!s) return "";
  return s
    .replace(/\{\{task_title\}\}/g, "{{entity.title ?? event.data.task_title ?? \"Untitled\"}}")
    .replace(/\{\{from_column\}\}/g, "{{event.data.from ?? \"—\"}}")
    .replace(/\{\{to_column\}\}/g, "{{event.data.to ?? \"—\"}}")
    .replace(/\{\{label\}\}/g, "{{event.data.label ?? \"—\"}}")
    .replace(/\{\{workflow\}\}/g, workflowName.replace(/[{}]/g, ""))
    .replace(/\{\{date\}\}/g, "{{now | date}}")
    .replace(/\{\{time\}\}/g, "{{now}}")
    .replace(/\{\{agent\}\}/g, "Agent");
}

/** True when the row has no v2 definition and must be adapted. */
export function isLegacyRow(row: { trigger_type?: string | null; steps?: string | null }): boolean {
  return !row.trigger_type || !row.steps;
}

export function legacyToV2(row: LegacyRow): AutomationDefinition {
  const cfg = parseLegacyConfig(row.action_config);
  const name = row.name ?? "Automation";
  const message = convertLegacyTemplate(cfg.message, name);
  const subject = convertLegacyTemplate(cfg.subject, name);
  const isScheduled = row.trigger_event === LEGACY_TRIGGER_SCHEDULED;

  const steps: Step[] = [];
  switch (row.action_type) {
    case "Send Notification":
      steps.push({ id: "notify", kind: "notify", config: { channel: "in_app", to: "{{org.id}}", subject: name, body: message || `${name} fired for {{event.type}}` } });
      break;
    case "Create Task":
      steps.push({
        id: "task",
        kind: "tool",
        config: { tool: "tasks.create", input: { title: message || (isScheduled ? `Daily: ${name} — {{now | date}}` : "Follow up: {{entity.title ?? event.entity_id}}") } },
      });
      break;
    case "Send Email":
      steps.push({
        id: "email",
        kind: "notify",
        config: { channel: "email", to: cfg.to ?? "", subject: subject || `KernelHub: ${name}`, body: message || `${name} fired for {{event.type}}` },
      });
      break;
    case "Send Slack Message":
    case "Trigger Webhook": {
      const url = cfg.webhook_url ?? cfg.url ?? "";
      steps.push({
        id: "webhook",
        kind: "webhook",
        config: {
          url,
          payload: row.action_type === "Send Slack Message" ? { text: message || `*${name}* fired` } : { event: "{{event.type}}", workflow: name, entity_id: "{{event.entity_id}}", data: "{{event.data}}" },
        },
      });
      break;
    }
    case "Deploy Agent":
    case "Run Agent (queued)":
      steps.push({ id: "agent", kind: "agent", config: { agent_id: cfg.agent_id ?? "", prompt: convertLegacyTemplate(cfg.prompt, name) || `Automation "${name}" fired for {{event.type}} on {{event.entity}} {{event.entity_id}}.` } });
      break;
    case "Run Playbook":
      steps.push({ id: "notify", kind: "notify", config: { channel: "in_app", to: "{{org.id}}", subject: name, body: `Legacy "Run Playbook" step (${cfg.playbook_id ?? "?"}) — re-create it as an agent step.` } });
      break;
    default:
      steps.push({ id: "notify", kind: "notify", config: { channel: "in_app", to: "{{org.id}}", subject: name, body: message || `${name} fired` } });
  }

  let conditions: ConditionNode | null = null;
  if (!isScheduled && row.kanban_label?.trim()) {
    conditions = { any: [{ field: "event.data.label", op: "eq", value: row.kanban_label.trim() }, { field: "entity.label", op: "eq", value: row.kanban_label.trim() }] };
  }

  return {
    name,
    description: null,
    trigger_type: isScheduled ? "schedule" : "event",
    trigger_config: isScheduled
      ? { schedule: { time: row.schedule_time ?? "09:00", timezone: row.schedule_timezone ?? "UTC", days: row.schedule_days ?? "daily" } }
      : { event_type: "production.card.moved" },
    conditions,
    steps,
    autonomy: "auto",
    enabled: row.status === "active",
  };
}
