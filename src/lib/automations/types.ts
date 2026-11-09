/**
 * Automations v2 — shared contracts (client-safe: no DB imports).
 *
 * An automation is `trigger → conditions → ordered steps`. Every execution is
 * an `automation_runs` row whose `context` is the data templates and
 * conditions read from (`{{event.data.x}}`, `entity.status`, …) and whose
 * `step_results` is the audit trail shown in the run drawer.
 */

export type TriggerType = "event" | "schedule" | "webhook" | "manual";

export interface ScheduleConfig {
  /** HH:MM, 24h. */
  time: string;
  timezone: string;
  /** daily | weekdays | mon … sun */
  days: string;
}

export interface TriggerConfig {
  /** Event type or prefix wildcard ("invoice.*"); `*` matches everything. */
  event_type?: string;
  /** Optional equality filter on event.data (applied before conditions). */
  filter?: Record<string, string | number | boolean | null>;
  schedule?: ScheduleConfig;
  /** Inbound webhook trigger: shared token checked on POST /api/automations/hooks/{id}?token= */
  webhook?: { token: string };
}

export const CONDITION_OPS = ["eq", "neq", "contains", "gt", "gte", "lt", "lte", "in", "exists", "changed_to"] as const;
export type ConditionOp = (typeof CONDITION_OPS)[number];

export const CONDITION_OP_LABELS: Record<ConditionOp, string> = {
  eq: "equals",
  neq: "does not equal",
  contains: "contains",
  gt: "greater than",
  gte: "at least",
  lt: "less than",
  lte: "at most",
  in: "is one of",
  exists: "exists",
  changed_to: "changed to",
};

export interface ConditionRule {
  /** Dotted path over the run context, e.g. "event.data.total_minor" or "entity.status". */
  field: string;
  op: ConditionOp;
  value?: unknown;
}

export interface ConditionGroup {
  all?: ConditionNode[];
  any?: ConditionNode[];
}

export type ConditionNode = ConditionRule | ConditionGroup;

export const STEP_KINDS = ["tool", "delay", "branch", "agent", "notify", "webhook", "approval"] as const;
export type StepKind = (typeof STEP_KINDS)[number];

export const STEP_KIND_LABELS: Record<StepKind, string> = {
  tool: "Run a tool",
  delay: "Wait",
  branch: "Branch on conditions",
  agent: "Ask an agent",
  notify: "Send a notification",
  webhook: "Call a webhook",
  approval: "Ask for approval",
};

export interface ToolStepConfig {
  tool: string;
  /** Templated input: strings may contain {{ }} expressions. */
  input: Record<string, unknown>;
}
export interface DelayStepConfig {
  minutes?: number;
  /** Templated ISO timestamp; wins over `minutes` when it renders to a date. */
  until?: string;
}
export interface BranchStepConfig {
  conditions: ConditionNode;
  /** Step id to jump to when true (null = next step). */
  then?: string | null;
  /** Step id to jump to when false (null = next step, "end" = stop). */
  else?: string | null;
}
export interface AgentStepConfig {
  agent_id: string;
  prompt: string;
}
export interface NotifyStepConfig {
  channel: "email" | "sms" | "in_app";
  /** Templated recipient (email / phone / user id). */
  to: string;
  subject?: string;
  body: string;
  /** When true the contact must have a current marketing consent (canSendMarketing). */
  marketing?: boolean;
  /** Templated contact id used for the consent check. */
  contact_id?: string;
}
export interface WebhookStepConfig {
  url: string;
  /** Optional HMAC secret (X-KernelHub-Signature). */
  secret?: string;
  /** Templated payload; defaults to the run context event. */
  payload?: Record<string, unknown>;
}
export interface ApprovalStepConfig {
  title: string;
  /** Templated description shown in the approvals inbox. */
  description?: string;
}

export type StepConfigByKind = {
  tool: ToolStepConfig;
  delay: DelayStepConfig;
  branch: BranchStepConfig;
  agent: AgentStepConfig;
  notify: NotifyStepConfig;
  webhook: WebhookStepConfig;
  approval: ApprovalStepConfig;
};

export type Step = {
  [K in StepKind]: { id: string; kind: K; name?: string; config: StepConfigByKind[K] };
}[StepKind];

export type AutomationAutonomy = "auto" | "approve";

/** Full v2 definition (what the editor saves and the engine executes). */
export interface AutomationDefinition {
  name: string;
  description?: string | null;
  trigger_type: TriggerType;
  trigger_config: TriggerConfig;
  conditions: ConditionNode | null;
  steps: Step[];
  autonomy: AutomationAutonomy;
  enabled: boolean;
}

export interface AutomationDTO extends AutomationDefinition {
  id: string;
  version: number;
  /** True when the row was stored in the legacy shape and converted on read. */
  legacy: boolean;
  template_key: string | null;
  run_count: number;
  error_count: number;
  last_run_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string | null;
}

export type RunStatus = "queued" | "running" | "waiting" | "done" | "failed" | "skipped";

export interface RunEvent {
  id: string;
  type: string;
  entity: string;
  entity_id: string;
  data: Record<string, unknown>;
  created_at: string;
}

/** What templates and conditions can see. */
export interface RunContext {
  event: RunEvent;
  entity: Record<string, unknown> | null;
  org: { id: string; name?: string | null };
  automation: { id: string; name: string };
  /** Output of earlier steps keyed by step id. */
  steps: Record<string, unknown>;
  now: string;
}

export type StepOutcomeStatus = "ok" | "failed" | "skipped" | "waiting";

export interface StepResult {
  step_id: string;
  kind: StepKind;
  name?: string;
  status: StepOutcomeStatus;
  summary: string;
  output?: unknown;
  error?: string;
  ms: number;
  at: string;
}

export interface AutomationRunDTO {
  id: string;
  automation_id: string;
  automation_name?: string | null;
  trigger_event_id: string | null;
  status: RunStatus;
  context: RunContext | null;
  step_results: StepResult[];
  step_index: number;
  approval_id: string | null;
  error: string | null;
  attempt: number;
  started_at: string | null;
  finished_at: string | null;
  resume_at: string | null;
  created_at: string;
}

/** Dry-run output from POST /api/automations/{id}/test. */
export interface PlanStep {
  step_id: string;
  kind: StepKind;
  name?: string;
  /** Rendered config (templates resolved, nothing executed). */
  rendered: unknown;
  /** Human summary of what would happen. */
  summary: string;
  /** Whether the step would pause for an approval under the automation's autonomy. */
  would_pause: boolean;
  warnings: string[];
}

export interface TestPlan {
  matched: boolean;
  /** Why the trigger did not match (null when matched). */
  reason: string | null;
  context: RunContext;
  steps: PlanStep[];
}

export const RUN_LIMITS = {
  maxSteps: 25,
  toolTimeoutMs: 10_000,
  maxDelayDays: 30,
  approvalTtlDays: 7,
  /** A run left in `running` longer than this (worker crash / function timeout) is failed so it can be retried. */
  runningLeaseMinutes: 15,
} as const;

/** Prefix on `approvals.run_id` that marks an automation (not agent) run. */
export const APPROVAL_RUN_PREFIX = "auto:";
