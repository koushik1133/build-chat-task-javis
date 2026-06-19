/**
 * Runs an AI agent job via Groq, stores output, and returns for delivery.
 */

import { query, queryOne } from "@/lib/dsql";
import { complete, type ChatMessage } from "@/lib/llm";
import { getDefaultSystemPrompt } from "@/lib/agent-templates";

export type AgentRow = {
  id: string;
  name: string;
  role: string;
  status: string;
  system_prompt?: string | null;
};

export type AgentRunResult = {
  runId: string;
  agent: AgentRow;
  prompt: string;
  output: string;
};

const DEFAULT_SYSTEM =
  "You are a helpful business AI agent. Produce a concise, actionable daily brief in plain language with bullet points.";

export function buildAgentPrompt(agent: AgentRow, customPrompt?: string | null): string {
  if (customPrompt?.trim()) {
    return customPrompt.trim();
  }
  return `Daily scheduled run for ${agent.name} (${agent.role}). Date: ${new Date().toLocaleDateString()}. Provide today's brief.`;
}

function resolveSystemPrompt(agent: AgentRow): string {
  if (agent.system_prompt?.trim()) return agent.system_prompt.trim();
  return getDefaultSystemPrompt(agent.role) || DEFAULT_SYSTEM;
}

export async function runAgentJob(
  userId: string,
  agentId: string,
  opts: {
    prompt?: string | null;
    workflowName?: string;
    automationId?: string | null;
  } = {}
): Promise<AgentRunResult | null> {
  const agent = await queryOne<AgentRow>(
    `SELECT id, name, role, status, system_prompt FROM agents WHERE id = $1 AND user_id = $2`,
    [agentId, userId]
  ).catch(() =>
    queryOne<AgentRow>(
      `SELECT id, name, role, status FROM agents WHERE id = $1 AND user_id = $2`,
      [agentId, userId]
    )
  );

  if (!agent) return null;

  const userPrompt = buildAgentPrompt(agent, opts.prompt);
  const system = resolveSystemPrompt(agent);

  const messages: ChatMessage[] = [
    { role: "system", content: system },
    { role: "user", content: userPrompt },
  ];

  let output: string;
  try {
    output = await complete(messages, { maxTokens: 1200 });
  } catch (err) {
    output = `Agent run failed: ${(err as Error).message}`;
  }

  if (!output.trim()) {
    output = "Agent completed but returned no content. Try adding a clearer prompt in the automation.";
  }

  const row = await queryOne<{ id: string }>(
    `INSERT INTO agent_runs (user_id, agent_id, automation_id, workflow_name, prompt, output)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [
      userId,
      agentId,
      opts.automationId ?? null,
      opts.workflowName ?? null,
      userPrompt,
      output,
    ]
  ).catch((dbErr) => {
    console.error("[agent-runner] failed to log agent_run:", dbErr);
    return { id: `fallback-run-${crypto.randomUUID()}` };
  });

  await query(
    `UPDATE agents SET status = 'active', tasks_completed = tasks_completed + 1 WHERE id = $1`,
    [agentId]
  ).catch(() => {});

  if (!row) return null;

  return { runId: row.id, agent, prompt: userPrompt, output };
}

export async function getRecentAgentRuns(userId: string, limit = 20) {
  return query(
    `SELECT r.id, r.agent_id, r.workflow_name, r.prompt, r.output, r.created_at,
            a.name AS agent_name, a.role AS agent_role
     FROM agent_runs r
     JOIN agents a ON a.id = r.agent_id
     WHERE r.user_id = $1
     ORDER BY r.created_at DESC
     LIMIT $2`,
    [userId, limit]
  ).catch(() => []);
}
