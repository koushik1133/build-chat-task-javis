import type { ZodTypeAny } from "zod";
import type { Area } from "@/lib/auth/roles";

/**
 * Shared contracts for the autonomous agent runtime.
 *
 * Everything an agent can do goes through a `ToolSpec`; everything an agent
 * does is recorded as run steps; anything side-effecting can be paused for a
 * human via `approvals`. `autonomy_level` on the agent is the single knob that
 * decides which tools pause.
 */

/** How much the agent may do without a human. */
export type AutonomyLevel = "draft" | "approve" | "auto";

export type RunStatus =
  | "queued"
  | "running"
  | "awaiting_approval"
  | "done"
  | "failed"
  | "cancelled";

export type TriggerKind = "manual" | "schedule" | "event" | "webhook" | "inbound" | "playbook" | "automation";

export type JobKind = "run" | "resume" | "playbook" | "outbox" | "eval";
export type JobStatus = "queued" | "running" | "done" | "failed" | "dead";

export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";

export type StepKind = "llm" | "tool" | "approval" | "note";

/** Everything a tool needs to know about who is calling it. */
export interface ToolContext {
  userId: string;
  runId: string;
  agentId: string | null;
  autonomy: AutonomyLevel;
  /**
   * Area permission check for the acting principal, when the caller has one
   * (copilot/MCP/approvals). Tools that read cross-area data fall back to the
   * owner matrix of `userId` (see `effectivePermissionsForOwner`).
   */
  can?: (area: Area, edit?: boolean) => boolean;
  /**
   * True once untrusted (customer-originated) content has entered this run's
   * context. High-risk write tools then always need a human, whatever the
   * autonomy level (the action firewall).
   */
  tainted?: boolean;
}

/** Outcome of a tool call. `requiresApproval` is decided BEFORE `run` is invoked. */
export interface ToolResult {
  ok: boolean;
  /** Serialisable payload handed back to the model. */
  data?: unknown;
  /** Human-readable summary for run steps and approval previews. */
  summary: string;
  error?: string;
}

export interface ToolSpec<TInput = unknown> {
  /** Dotted, stable name, e.g. "crm.create_contact". */
  name: string;
  description: string;
  /** Module the tool belongs to — used for scoping copilots and MCP listing. */
  module: string;
  /** Validation for the model's arguments. */
  input: ZodTypeAny;
  /** JSON Schema handed to the model (zod v3 has no built-in exporter). */
  parameters: Record<string, unknown>;
  scope: "read" | "write";
  /** Blast radius of a write. Defaults to a name-based classification (see registry `riskOf`). */
  risk?: "low" | "medium" | "high";
  /** Result contains customer/visitor-originated text: wrap it as untrusted before the model sees it. */
  untrustedOutput?: boolean;
  /**
   * Whether this call must pause for a human. A function may inspect the
   * validated input (e.g. only external sends need approval).
   */
  requiresApproval?: boolean | ((input: TInput, ctx: ToolContext) => boolean);
  /** One-line preview shown in the approvals inbox, built from validated input. */
  preview?: (input: TInput) => string;
  run: (ctx: ToolContext, input: TInput) => Promise<ToolResult>;
}

/** A row of `agents` as the runtime sees it. */
export interface AgentDefinition {
  id: string;
  user_id: string;
  name: string;
  role: string;
  system_prompt: string | null;
  /** JSON array of tool names the agent may call; null = all tools. */
  tools: string | null;
  model: string | null;
  autonomy_level: AutonomyLevel | null;
  max_steps: number | null;
}

/** Payload carried by an `agent_jobs` row. */
export type JobPayload =
  | { kind: "run"; runId: string }
  | { kind: "resume"; runId: string; approvalId: string }
  | { kind: "playbook"; playbookId: string; entityId?: string }
  | { kind: "outbox"; outboxId: string }
  | { kind: "eval"; evalRunId: string };

export interface JobRow {
  id: string;
  user_id: string;
  kind: JobKind;
  payload: string;
  status: JobStatus;
  attempts: number;
  max_attempts: number;
  run_after: string;
  locked_at: string | null;
  locked_by: string | null;
  last_error: string | null;
  created_at: string;
}

export interface EventRecord {
  type: string;
  entity: string;
  entityId: string;
  data?: Record<string, unknown>;
}

/** Model-facing tool call as returned by the LLM router. */
export interface LlmToolCall {
  id: string;
  name: string;
  /** Raw JSON string of arguments from the model. */
  arguments: string;
}

export interface LlmTurnResult {
  content: string | null;
  toolCalls: LlmToolCall[];
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  finishReason: string | null;
}

/** Message shapes accepted by the router (a superset of ChatMessage). */
export type RouterMessage =
  | { role: "system" | "user" | "assistant"; content: string }
  | { role: "assistant"; content: string | null; tool_calls: { id: string; type: "function"; function: { name: string; arguments: string } }[] }
  | { role: "tool"; tool_call_id: string; content: string };

/** Hard ceilings so one run can never spend without bound. */
export const RUN_LIMITS = {
  defaultMaxSteps: 8,
  absoluteMaxSteps: 20,
  maxToolsPerRun: 12,
  stepTimeoutMs: 25_000,
  leaseMs: 5 * 60_000,
} as const;
