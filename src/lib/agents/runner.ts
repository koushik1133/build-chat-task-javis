import { randomUUID } from "crypto";
import { query, queryOne } from "@/lib/dsql";
import { redactSecrets } from "@/lib/secure-store";
import { settleRunOutcome } from "@/lib/credits/outcomes";
import { enqueueJob } from "./queue";
import {
  CHECKPOINT_STEP_NAME,
  executeTool,
  persistStep,
  runAgentLoop,
  toolResultContent,
  resolveAutonomy,
  type Checkpoint,
  type LoopOutcome,
  type LoopRun,
} from "./loop";
import { getTool } from "./registry";
import { ensureToolsLoaded } from "./tools";
import type { AgentDefinition, ApprovalStatus, RouterMessage, RunStatus, TriggerKind } from "./types";

/**
 * Run lifecycle: create (`startRun`), execute (`executeRun`), pause/resume
 * around a human decision (`resumeRun`) and cancel. Every function is scoped
 * by the run's `user_id`, so a job can never touch another tenant's data.
 */

export class AgentNotFoundError extends Error {
  constructor(agentId: string) {
    super(`Agent not found: ${agentId}`);
    this.name = "AgentNotFoundError";
  }
}

export interface AgentRow extends AgentDefinition {
  status: string;
  template_id?: string | null;
  tasks_completed?: number | null;
}

export interface RunRow {
  id: string;
  user_id: string;
  agent_id: string;
  automation_id: string | null;
  workflow_name: string | null;
  prompt: string | null;
  output: string;
  status: RunStatus | null;
  trigger_kind: string | null;
  trigger_ref: string | null;
  error: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  cost_micros: number | string | null;
  started_at: string | null;
  finished_at: string | null;
  attempt: number | null;
  created_at: string;
}

export interface StartRunOptions {
  prompt?: string | null;
  triggerKind?: TriggerKind;
  triggerRef?: string | null;
  automationId?: string | null;
  workflowName?: string | null;
  /** Set false when the caller executes the run inline (default: queue a job). */
  enqueue?: boolean;
}

export type RunOutcome =
  | { status: "done"; output: string }
  | { status: "awaiting_approval"; approvalId: string; toolName: string }
  | { status: "failed"; error: string }
  | { status: "cancelled" };

export function buildAgentPrompt(agent: { name: string; role: string }, customPrompt?: string | null): string {
  if (customPrompt?.trim()) return customPrompt.trim();
  return `Daily scheduled run for ${agent.name} (${agent.role}). Date: ${new Date().toLocaleDateString()}. Provide today's brief.`;
}

export async function loadAgent(userId: string, agentId: string): Promise<AgentRow | null> {
  const row = await queryOne<Record<string, unknown>>(
    `SELECT * FROM agents WHERE id = $1 AND user_id = $2`,
    [agentId, userId]
  ).catch(() => null);
  if (!row) return null;
  return {
    id: String(row.id),
    user_id: String(row.user_id),
    name: String(row.name ?? ""),
    role: String(row.role ?? "General Agent"),
    system_prompt: (row.system_prompt as string | null) ?? null,
    tools: (row.tools as string | null) ?? null,
    model: (row.model as string | null) ?? null,
    autonomy_level: resolveAutonomy(row.autonomy_level as string | null),
    max_steps: row.max_steps == null ? null : Number(row.max_steps),
    status: String(row.status ?? "idle"),
    template_id: (row.template_id as string | null) ?? null,
    tasks_completed: row.tasks_completed == null ? null : Number(row.tasks_completed),
  };
}

export async function getRun(runId: string, userId?: string): Promise<RunRow | null> {
  if (userId) {
    return queryOne<RunRow>(`SELECT * FROM agent_runs WHERE id = $1 AND user_id = $2`, [runId, userId]).catch(() => null);
  }
  return queryOne<RunRow>(`SELECT * FROM agent_runs WHERE id = $1`, [runId]).catch(() => null);
}

/** Insert a queued run and a job to execute it. Returns the run id. */
export async function startRun(userId: string, agentId: string, opts: StartRunOptions = {}): Promise<string> {
  const agent = await loadAgent(userId, agentId);
  if (!agent) throw new AgentNotFoundError(agentId);

  const runId = randomUUID();
  const prompt = buildAgentPrompt(agent, opts.prompt);
  await query(
    `INSERT INTO agent_runs (id, user_id, agent_id, automation_id, workflow_name, prompt, output, status, trigger_kind, trigger_ref, attempt)
     VALUES ($1, $2, $3, $4, $5, $6, '', 'queued', $7, $8, 0)`,
    [
      runId,
      userId,
      agentId,
      opts.automationId ?? null,
      opts.workflowName ?? null,
      prompt,
      opts.triggerKind ?? "manual",
      opts.triggerRef ?? null,
    ]
  );
  if (opts.enqueue !== false) await enqueueJob(userId, { kind: "run", runId });
  return runId;
}

function errorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return redactSecrets(raw).slice(0, 2000);
}

async function markRunning(runId: string, workerId: string): Promise<void> {
  await query(
    `UPDATE agent_runs
     SET status = 'running', started_at = COALESCE(started_at, NOW()), attempt = COALESCE(attempt, 0) + 1, error = NULL
     WHERE id = $1`,
    [runId]
  );
  void workerId;
}

async function finalize(run: RunRow, outcome: LoopOutcome | { status: "failed"; error: string }): Promise<RunOutcome> {
  if (outcome.status === "done") {
    const output = outcome.output.trim() || "Agent completed but returned no content. Try adding a clearer prompt.";
    await query(
      `UPDATE agent_runs SET status = 'done', output = $2, finished_at = NOW(), error = NULL WHERE id = $1`,
      [run.id, output]
    );
    await query(
      `UPDATE agents SET status = 'active', tasks_completed = COALESCE(tasks_completed, 0) + 1 WHERE id = $1 AND user_id = $2`,
      [run.agent_id, run.user_id]
    ).catch(() => {});
    // Outcome pricing: charge once when the agent's outcome event fired during this run.
    await settleRunOutcome(run).catch((err) => console.error(`[agent-runner] outcome settlement failed for ${run.id}:`, err));
    return { status: "done", output };
  }
  if (outcome.status === "awaiting_approval") {
    await query(`UPDATE agent_runs SET status = 'awaiting_approval' WHERE id = $1`, [run.id]);
    return outcome;
  }
  await query(
    `UPDATE agent_runs SET status = 'failed', error = $2, finished_at = NOW() WHERE id = $1`,
    [run.id, outcome.error]
  );
  return outcome;
}

async function isCancelled(runId: string): Promise<boolean> {
  const row = await queryOne<{ status: string | null }>(`SELECT status FROM agent_runs WHERE id = $1`, [runId]).catch(() => null);
  return row?.status === "cancelled";
}

/** Execute a queued run to completion, an approval pause, or failure. */
export async function executeRun(runId: string, workerId = "inline"): Promise<RunOutcome> {
  ensureToolsLoaded();
  const run = await getRun(runId);
  if (!run) return { status: "failed", error: "run not found" };
  if (run.status === "cancelled") return { status: "cancelled" };
  if (run.status === "done") return { status: "done", output: run.output };

  const agent = await loadAgent(run.user_id, run.agent_id);
  if (!agent) return finalize(run, { status: "failed", error: "agent not found" });

  await markRunning(run.id, workerId);
  const loopRun: LoopRun = { id: run.id, user_id: run.user_id, agent_id: run.agent_id, prompt: run.prompt ?? buildAgentPrompt(agent) };

  try {
    const outcome = await runAgentLoop(loopRun, agent);
    if (await isCancelled(run.id)) return { status: "cancelled" };
    return await finalize(run, outcome);
  } catch (err) {
    console.error(`[agent-runner] run ${run.id} failed:`, err);
    return finalize(run, { status: "failed", error: errorMessage(err) });
  }
}

async function loadCheckpoint(runId: string, approvalId: string): Promise<Checkpoint | null> {
  const rows = await query<{ input: string | null }>(
    `SELECT input FROM agent_run_steps WHERE run_id = $1 AND kind = 'note' AND name = $2 ORDER BY idx DESC LIMIT 10`,
    [runId, CHECKPOINT_STEP_NAME]
  ).catch(() => []);
  for (const r of rows) {
    try {
      const cp = JSON.parse(r.input ?? "") as Checkpoint;
      if (cp && Array.isArray(cp.messages) && cp.approvalId === approvalId) return cp;
    } catch {
      /* skip malformed */
    }
  }
  // Fall back to the latest checkpoint when the approval id was not recorded.
  try {
    const cp = rows[0] ? (JSON.parse(rows[0].input ?? "") as Checkpoint) : null;
    return cp && Array.isArray(cp.messages) ? cp : null;
  } catch {
    return null;
  }
}

function parseApprovedInput(raw: string | null): unknown | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}

/** Continue a paused run after the human decided on `approvalId`. */
export async function resumeRun(runId: string, approvalId: string, workerId = "inline"): Promise<RunOutcome> {
  ensureToolsLoaded();
  const run = await getRun(runId);
  if (!run) return { status: "failed", error: "run not found" };
  if (run.status === "cancelled") return { status: "cancelled" };

  const agent = await loadAgent(run.user_id, run.agent_id);
  if (!agent) return finalize(run, { status: "failed", error: "agent not found" });

  const approval = await queryOne<{ id: string; status: ApprovalStatus; tool_name: string; input: string | null }>(
    `SELECT id, status, tool_name, input FROM approvals WHERE id = $1 AND user_id = $2 AND run_id = $3`,
    [approvalId, run.user_id, run.id]
  ).catch(() => null);
  if (!approval) return finalize(run, { status: "failed", error: "approval not found" });
  if (approval.status === "pending") return { status: "awaiting_approval", approvalId, toolName: approval.tool_name };

  const cp = await loadCheckpoint(run.id, approvalId);
  if (!cp) return finalize(run, { status: "failed", error: "checkpoint not found; cannot resume" });

  await markRunning(run.id, workerId);
  const loopRun: LoopRun = { id: run.id, user_id: run.user_id, agent_id: run.agent_id, prompt: run.prompt ?? "" };
  const messages: RouterMessage[] = [...cp.messages];

  try {
    let content: string;
    if (approval.status === "approved") {
      const spec = getTool(cp.toolName);
      if (!spec) {
        content = JSON.stringify({ ok: false, error: `Tool ${cp.toolName} is no longer available.` });
      } else {
        // The approvals row is authoritative: an operator may have edited the input before approving.
        const input = parseApprovedInput(approval.input) ?? cp.input;
        const started = Date.now();
        const result = await executeTool(
          spec,
          { userId: run.user_id, runId: run.id, agentId: agent.id, autonomy: resolveAutonomy(agent.autonomy_level) },
          input
        );
        await persistStep(loopRun, {
          kind: "tool",
          name: spec.name,
          input: JSON.stringify(input),
          output: result.ok ? JSON.stringify(result.data ?? result.summary).slice(0, 2000) : `error: ${result.error ?? result.summary}`,
          ms: Date.now() - started,
        });
        content = toolResultContent(result);
      }
    } else {
      await persistStep(loopRun, { kind: "note", name: "approval_decision", output: `${approval.status}: ${cp.toolName}` });
      content = JSON.stringify({
        ok: false,
        error: approval.status === "expired" ? "Approval expired before a decision was made" : "Rejected by user",
      });
    }
    messages.push({ role: "tool", tool_call_id: cp.toolCallId, content });

    const outcome = await runAgentLoop(loopRun, agent, {
      resume: { messages, pendingCalls: cp.pendingCalls ?? [], turn: cp.turn ?? 0 },
    });
    if (await isCancelled(run.id)) return { status: "cancelled" };
    return await finalize(run, outcome);
  } catch (err) {
    console.error(`[agent-runner] resume ${run.id} failed:`, err);
    return finalize(run, { status: "failed", error: errorMessage(err) });
  }
}

/** Mark a run cancelled; a worker mid-run notices at its next checkpoint. */
export async function cancelRun(userId: string, runId: string): Promise<boolean> {
  const row = await queryOne<{ id: string }>(
    `UPDATE agent_runs SET status = 'cancelled', finished_at = NOW()
     WHERE id = $1 AND user_id = $2 AND status IN ('queued', 'running', 'awaiting_approval')
     RETURNING id`,
    [runId, userId]
  ).catch(() => null);
  if (!row) return false;
  await query(
    `UPDATE approvals SET status = 'expired', decided_at = NOW() WHERE run_id = $1 AND user_id = $2 AND status = 'pending'`,
    [runId, userId]
  ).catch(() => {});
  return true;
}
