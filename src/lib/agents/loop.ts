import { canFromStored } from "./principal";
import { randomUUID } from "crypto";
import { query, queryOne } from "@/lib/dsql";
import { completeWithTools } from "@/lib/llm/router";
import { assertBudget } from "@/lib/llm/budgets";
import { recordUsage } from "@/lib/llm/metering";
import { parseModelJson } from "@/lib/model-json";
import { getDefaultSystemPrompt } from "@/lib/agent-templates";
import { formatCorrectionsBlock, recallCorrections } from "./memory";
import { getTool, hasUntrustedOutput, listTools, needsApproval, taintForcesApproval, TAINT_REASON } from "./registry";
import { containsUntrusted, UNTRUSTED_PREAMBLE, wrapUntrustedJson } from "@/lib/ai/untrusted";
import { redactForLog } from "@/lib/ai/output-guard";
import { ensureToolsLoaded } from "./tools";
import {
  RUN_LIMITS,
  type AgentDefinition,
  type AutonomyLevel,
  type LlmToolCall,
  type RouterMessage,
  type StepKind,
  type ToolContext,
  type ToolResult,
  type ToolSpec,
} from "./types";

/**
 * The tool-calling loop: one model turn, run/gate every tool call it made,
 * feed the results back, repeat until the model answers in plain text or the
 * step budget runs out.
 *
 * Model misbehaviour (bad JSON, unknown tools, invalid arguments) is never
 * fatal — it is reported back to the model as a tool message so it can
 * adapt. Only infrastructure failures (DB, budget, provider) throw.
 */

/** The subset of an `agent_runs` row the loop needs. */
export interface LoopRun {
  id: string;
  user_id: string;
  agent_id: string;
  prompt: string;
  /** JSON area->{view,edit} of the principal that triggered the run (null = owner matrix). */
  principal_permissions?: string | null;
}

/** Enough state to rebuild the loop after a human decision. */
export interface Checkpoint {
  messages: RouterMessage[];
  /** The tool call that paused the run. */
  toolCallId: string;
  toolName: string;
  /** Validated input for that call. */
  input: unknown;
  /** Tool calls from the same model turn that were not yet processed. */
  pendingCalls: LlmToolCall[];
  /** Model turns consumed so far. */
  turn: number;
  approvalId: string;
}

export interface ResumeState {
  messages: RouterMessage[];
  /** Remaining tool calls of the paused turn (after the decided one). */
  pendingCalls: LlmToolCall[];
  turn: number;
}

export interface LoopOptions {
  /** Continue from a checkpoint instead of building the initial messages. */
  resume?: ResumeState;
}

export type LoopOutcome =
  | { status: "done"; output: string; turns: number }
  | { status: "awaiting_approval"; approvalId: string; toolName: string };

export const CHECKPOINT_STEP_NAME = "checkpoint";

const DEFAULT_SYSTEM =
  "You are a helpful business AI agent. Produce a concise, actionable brief in plain language with bullet points.";

// ── step persistence ─────────────────────────────────────────────────────────

async function nextStepIdx(runId: string): Promise<number> {
  const row = await queryOne<{ n: number | string | null }>(
    `SELECT COALESCE(MAX(idx), -1) + 1 AS n FROM agent_run_steps WHERE run_id = $1`,
    [runId]
  ).catch(() => null);
  return Number(row?.n ?? 0) || 0;
}

export interface StepInput {
  kind: StepKind;
  name?: string | null;
  input?: string | null;
  output?: string | null;
  tokens?: number | null;
  ms?: number | null;
}

export async function persistStep(run: { id: string; user_id: string }, step: StepInput): Promise<string> {
  const id = randomUUID();
  const idx = await nextStepIdx(run.id);
  await query(
    `INSERT INTO agent_run_steps (id, run_id, user_id, idx, kind, name, input, output, tokens, ms)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      id,
      run.id,
      run.user_id,
      idx,
      step.kind,
      step.name ?? null,
      step.input ?? null,
      step.output ?? null,
      step.tokens ?? null,
      step.ms ?? null,
    ]
  );
  return id;
}

async function addRunUsage(runId: string, tokensIn: number, tokensOut: number, costMicros: number) {
  await query(
    `UPDATE agent_runs
     SET tokens_in = COALESCE(tokens_in, 0) + $2,
         tokens_out = COALESCE(tokens_out, 0) + $3,
         cost_micros = COALESCE(cost_micros, 0) + $4
     WHERE id = $1`,
    [runId, tokensIn, tokensOut, costMicros]
  ).catch((err) => console.error("[agent-loop] failed to record run usage:", err));
}

// ── prompt building ──────────────────────────────────────────────────────────

export function parseAgentToolNames(raw: string | null | undefined): string[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const names = parsed.filter((n): n is string => typeof n === "string" && n.length > 0);
    return names.length > 0 ? names : null;
  } catch {
    return null;
  }
}

export function resolveAutonomy(level: string | null | undefined): AutonomyLevel {
  return level === "draft" || level === "auto" ? level : "approve";
}

export function resolveMaxSteps(maxSteps: number | null | undefined): number {
  const requested = Number(maxSteps) > 0 ? Number(maxSteps) : RUN_LIMITS.defaultMaxSteps;
  return Math.min(requested, RUN_LIMITS.absoluteMaxSteps);
}

function autonomyDescription(level: AutonomyLevel): string {
  switch (level) {
    case "draft":
      return "DRAFT: every write action pauses for human approval before it is applied. Read actions run immediately.";
    case "auto":
      return "AUTO: all actions run immediately without human review. Be careful and conservative.";
    default:
      return "APPROVE: sensitive write actions pause for human approval; read actions run immediately.";
  }
}

export async function buildSystemPrompt(
  agent: AgentDefinition,
  tools: ToolSpec[],
  autonomy: AutonomyLevel,
  /** The run's task — used to recall the most relevant operator corrections. */
  task?: string | null
): Promise<string> {
  let system = agent.system_prompt?.trim() || getDefaultSystemPrompt(agent.role) || DEFAULT_SYSTEM;

  system += "\n\n## Runtime\n";
  system += `You are "${agent.name}" (${agent.role}). Current date/time: ${new Date().toISOString()}.\n`;
  system += `Autonomy level — ${autonomyDescription(autonomy)}\n`;
  if (tools.length > 0) {
    system += "\nAvailable tools:\n";
    for (const t of tools) system += `- ${t.name} (${t.scope}): ${t.description}\n`;
    system +=
      "\nCall tools when you need real data or need to act. When a tool result says it is awaiting approval, " +
      "do not retry it. When you have finished, reply with a plain-text summary of what you did and found.";
  } else {
    system += "\nNo tools are available for this run. Answer directly from the instructions.";
  }

  system += `\n\n${UNTRUSTED_PREAMBLE}\n`;

  // Corrections-as-memory: the top-k operator corrections most relevant to this task.
  const corrections = await recallCorrections(agent.user_id, agent.id, 5, task).catch(() => []);
  system += formatCorrectionsBlock(corrections);
  return system;
}

// ── tool execution ───────────────────────────────────────────────────────────

function summarize(value: unknown, max = 2000): string {
  let text: string;
  if (typeof value === "string") text = value;
  else {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  }
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Step persistence keeps debugging detail but redacts PII in customer-originated output. */
function summarizeForStep(spec: ToolSpec, value: unknown): string {
  const text = summarize(value);
  return hasUntrustedOutput(spec) ? redactForLog(text) : text;
}

/** Run one tool with the per-step timeout. Never throws. */
export async function executeTool(spec: ToolSpec, ctx: ToolContext, input: unknown): Promise<ToolResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<ToolResult>((resolve) => {
    timer = setTimeout(
      () => resolve({ ok: false, summary: `Tool ${spec.name} timed out`, error: `timed out after ${RUN_LIMITS.stepTimeoutMs}ms` }),
      RUN_LIMITS.stepTimeoutMs
    );
  });
  try {
    return await Promise.race([spec.run(ctx, input), timeout]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, summary: `Tool ${spec.name} failed`, error: message };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** What the model sees after a tool call. */
export function toolResultContent(result: ToolResult): string {
  if (!result.ok) return JSON.stringify({ ok: false, error: result.error ?? result.summary, summary: result.summary });
  return JSON.stringify(result.data !== undefined ? result.data : { ok: true, summary: result.summary });
}

/**
 * Run (or gate) one tool call and persist its step. Returns a checkpoint
 * request when the call needs approval; otherwise the tool message to append.
 */
export async function runToolCall(
  run: LoopRun,
  agent: AgentDefinition,
  ctx: ToolContext,
  call: LlmToolCall
): Promise<
  | { kind: "message"; message: RouterMessage }
  | { kind: "pause"; approvalId: string; toolName: string; input: unknown }
> {
  const toolMessage = (content: string): { kind: "message"; message: RouterMessage } => ({
    kind: "message",
    message: { role: "tool", tool_call_id: call.id, content },
  });

  const spec = getTool(call.name);
  if (!spec) {
    await persistStep(run, { kind: "tool", name: call.name, input: call.arguments, output: "error: unknown tool" });
    return toolMessage(JSON.stringify({ ok: false, error: `Unknown tool "${call.name}". Use only the tools listed.` }));
  }

  const rawArgs = call.arguments?.trim() ? parseModelJson(call.arguments) : {};
  if (rawArgs === null) {
    await persistStep(run, { kind: "tool", name: spec.name, input: call.arguments, output: "error: arguments were not valid JSON" });
    return toolMessage(JSON.stringify({ ok: false, error: "Arguments were not valid JSON. Send a JSON object." }));
  }

  const parsed = spec.input.safeParse(rawArgs);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    await persistStep(run, { kind: "tool", name: spec.name, input: summarize(rawArgs), output: `error: invalid arguments — ${issues}` });
    return toolMessage(JSON.stringify({ ok: false, error: `Invalid arguments: ${issues}` }));
  }

  const input = parsed.data;

  if (needsApproval(spec, input, ctx)) {
    let preview: string;
    try {
      preview = spec.preview ? spec.preview(input) : summarize(input, 500);
    } catch {
      preview = summarize(input, 500);
    }
    if (taintForcesApproval(spec, ctx)) preview = `${TAINT_REASON} — ${preview}`.slice(0, 500);
    const approvalId = randomUUID();
    await query(
      `INSERT INTO approvals (id, user_id, run_id, agent_id, tool_name, input, preview, status, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8)`,
      [
        approvalId,
        run.user_id,
        run.id,
        agent.id,
        spec.name,
        JSON.stringify(input),
        preview,
        new Date(Date.now() + 7 * 24 * 60 * 60_000).toISOString(),
      ]
    );
    await persistStep(run, { kind: "approval", name: spec.name, input: JSON.stringify(input), output: preview });
    return { kind: "pause", approvalId, toolName: spec.name, input };
  }

  const started = Date.now();
  const result = await executeTool(spec, ctx, input);
  await persistStep(run, {
    kind: "tool",
    name: spec.name,
    input: JSON.stringify(input),
    output: result.ok ? summarizeForStep(spec, result.data !== undefined ? result.data : result.summary) : `error: ${result.error ?? result.summary}`,
    ms: Date.now() - started,
  });
  if (result.ok && hasUntrustedOutput(spec)) {
    ctx.tainted = true;
    return toolMessage(wrapUntrustedJson(spec.name, result.data !== undefined ? result.data : result.summary, 4000));
  }
  return toolMessage(toolResultContent(result));
}

// ── the loop ─────────────────────────────────────────────────────────────────

async function saveCheckpoint(run: LoopRun, cp: Checkpoint): Promise<void> {
  await persistStep(run, {
    kind: "note",
    name: CHECKPOINT_STEP_NAME,
    input: JSON.stringify(cp),
    output: `Paused for approval of ${cp.toolName}`,
  });
}

export async function runAgentLoop(run: LoopRun, agent: AgentDefinition, opts: LoopOptions = {}): Promise<LoopOutcome> {
  ensureToolsLoaded();

  const autonomy = resolveAutonomy(agent.autonomy_level);
  const maxSteps = resolveMaxSteps(agent.max_steps);
  const tools = listTools({ names: parseAgentToolNames(agent.tools) }).slice(0, RUN_LIMITS.maxToolsPerRun);
  const ctx: ToolContext = { userId: run.user_id, runId: run.id, agentId: agent.id, autonomy, can: canFromStored(run.principal_permissions) };

  let messages: RouterMessage[];
  let turn: number;
  let pendingCalls: LlmToolCall[] = [];

  if (opts.resume) {
    messages = opts.resume.messages;
    turn = opts.resume.turn;
    pendingCalls = opts.resume.pendingCalls;
  } else {
    const system = await buildSystemPrompt(agent, tools, autonomy, run.prompt);
    messages = [
      { role: "system", content: system },
      { role: "user", content: run.prompt },
    ];
    turn = 0;
  }

  // Taint: untrusted content already in the context (inbound prompt, or a resumed run's history).
  if (containsUntrusted(run.prompt) || messages.some((m) => m.role !== "system" && typeof m.content === "string" && containsUntrusted(m.content))) {
    ctx.tainted = true;
  }

  let lastText: string | null = null;

  // Process tool calls (from a fresh turn or left over from a paused one).
  const processCalls = async (calls: LlmToolCall[]): Promise<LoopOutcome | null> => {
    for (let i = 0; i < calls.length; i++) {
      const call = calls[i];
      const res = await runToolCall(run, agent, ctx, call);
      if (res.kind === "pause") {
        await saveCheckpoint(run, {
          messages,
          toolCallId: call.id,
          toolName: res.toolName,
          input: res.input,
          pendingCalls: calls.slice(i + 1),
          turn,
          approvalId: res.approvalId,
        });
        return { status: "awaiting_approval", approvalId: res.approvalId, toolName: res.toolName };
      }
      messages.push(res.message);
    }
    return null;
  };

  if (pendingCalls.length > 0) {
    const paused = await processCalls(pendingCalls);
    if (paused) return paused;
  }

  while (turn < maxSteps) {
    const budget = await assertBudget(run.user_id, "agent");
    const started = Date.now();
    const result = await completeWithTools(messages, {
      tools,
      model: agent.model,
      allowlist: budget.allowlist,
      ...(budget.maxTokensPerCall != null ? { maxTokens: budget.maxTokensPerCall } : {}),
    });
    turn++;

    const cost = await recordUsage(run.user_id, {
      runId: run.id,
      feature: "agent",
      provider: result.provider,
      model: result.model,
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
    });
    await addRunUsage(run.id, result.promptTokens, result.completionTokens, cost);
    await persistStep(run, {
      kind: "llm",
      name: `${result.provider}/${result.model}`,
      input: `turn ${turn}`,
      output: summarize(
        result.toolCalls.length > 0
          ? { content: result.content, tool_calls: result.toolCalls.map((c) => ({ name: c.name, arguments: c.arguments })) }
          : result.content ?? ""
      ),
      tokens: result.promptTokens + result.completionTokens,
      ms: Date.now() - started,
    });

    if (result.toolCalls.length === 0) {
      const output = (result.content ?? "").trim();
      return { status: "done", output, turns: turn };
    }

    lastText = result.content;
    messages.push({
      role: "assistant",
      content: result.content,
      tool_calls: result.toolCalls.map((c) => ({
        id: c.id,
        type: "function" as const,
        function: { name: c.name, arguments: c.arguments },
      })),
    });

    const paused = await processCalls(result.toolCalls);
    if (paused) return paused;
  }

  await persistStep(run, {
    kind: "note",
    name: "step_limit",
    output: `Reached the step limit (${maxSteps}) before the agent finished.`,
  });
  const output = lastText?.trim() || `Stopped after ${maxSteps} steps without a final answer.`;
  return { status: "done", output, turns: turn };
}
