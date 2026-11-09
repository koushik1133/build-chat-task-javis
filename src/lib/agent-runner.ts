/**
 * Facade over the agent runtime (`@/lib/agents/runner`).
 *
 * Automations and the swarm route expect a synchronous "run and give me the
 * output" call, so `runAgentJob` creates the run and executes it inline. New
 * code should use `startRun` + the worker instead.
 */

import type { RunPrincipal } from "@/lib/agents/principal";
import { query } from "@/lib/dsql";
import {
  AgentNotFoundError,
  buildAgentPrompt,
  executeRun,
  getRun,
  loadAgent,
  startRun,
  type AgentRow,
} from "@/lib/agents/runner";

export type { AgentRow };
export { buildAgentPrompt };

export type AgentRunResult = {
  runId: string;
  agent: AgentRow;
  prompt: string;
  output: string;
  status: "done" | "awaiting_approval" | "failed" | "cancelled";
};

export async function runAgentJob(
  userId: string,
  agentId: string,
  opts: {
    prompt?: string | null;
    workflowName?: string;
    automationId?: string | null;
    principal?: RunPrincipal | null;
  } = {}
): Promise<AgentRunResult | null> {
  const agent = await loadAgent(userId, agentId);
  if (!agent) return null;

  let runId: string;
  try {
    runId = await startRun(userId, agentId, {
      prompt: opts.prompt,
      workflowName: opts.workflowName ?? null,
      automationId: opts.automationId ?? null,
      triggerKind: opts.automationId ? "automation" : "manual",
      enqueue: false,
      principal: opts.principal ?? null,
    });
  } catch (err) {
    if (err instanceof AgentNotFoundError) return null;
    throw err;
  }

  const outcome = await executeRun(runId, "inline");
  const run = await getRun(runId, userId);
  const prompt = run?.prompt ?? buildAgentPrompt(agent, opts.prompt);

  let output: string;
  switch (outcome.status) {
    case "done":
      output = outcome.output;
      break;
    case "awaiting_approval":
      output = `Run is paused: "${outcome.toolName}" needs your approval. Open the Approvals inbox to continue.`;
      break;
    case "cancelled":
      output = "Run was cancelled.";
      break;
    default:
      output = `Agent run failed: ${outcome.error}`;
  }

  return { runId, agent, prompt, output, status: outcome.status };
}

export async function getRecentAgentRuns(userId: string, limit = 20) {
  return query(
    `SELECT r.id, r.agent_id, r.workflow_name, r.prompt, r.output, r.status, r.trigger_kind,
            r.tokens_in, r.tokens_out, r.cost_micros, r.error, r.started_at, r.finished_at, r.created_at,
            a.name AS agent_name, a.role AS agent_role
     FROM agent_runs r
     JOIN agents a ON a.id = r.agent_id
     WHERE r.user_id = $1
     ORDER BY r.created_at DESC
     LIMIT $2`,
    [userId, limit]
  ).catch(() => []);
}
