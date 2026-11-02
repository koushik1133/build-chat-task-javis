import { randomUUID } from "crypto";
import { query, queryOne } from "@/lib/dsql";
import { assertBudget } from "@/lib/llm/budgets";
import { recordUsage } from "@/lib/llm/metering";
import { completeWithTools } from "@/lib/llm/router";
import { parseModelJson } from "@/lib/model-json";
import { enqueueJob } from "@/lib/agents/queue";
import { buildSystemPrompt, executeTool, parseAgentToolNames, resolveMaxSteps, toolResultContent } from "@/lib/agents/loop";
import { getTool, listTools, needsApproval } from "@/lib/agents/registry";
import { loadAgent, type AgentRow } from "@/lib/agents/runner";
import { ensureToolsLoaded } from "@/lib/agents/tools";
import { RUN_LIMITS, type LlmToolCall, type RouterMessage, type ToolContext } from "@/lib/agents/types";
import { judgeCase } from "./judge";
import { aggregateScores, parseCases, parseResults, type CaseResult, type EvalCase, type TranscriptEntry } from "./score";

/**
 * Evaluation harness.
 *
 * Each case runs through the real agent runtime (same system prompt, tools,
 * model and budget checks) in a sandbox: read tools execute, write tools —
 * anything that would pause for approval under `draft` autonomy — are not
 * executed but recorded as "would call X" and reported back to the model as a
 * simulated success. An LLM judge then scores the final answer 0–100.
 *
 * Runs are `agent_jobs` of kind "eval" (see the cron tick) or run inline.
 */

export type EvalRunStatus = "queued" | "running" | "done" | "failed";

export interface EvalRow {
  id: string;
  user_id: string;
  agent_id: string;
  name: string;
  cases: string | null;
  created_at: string;
  updated_at: string | null;
}

export interface EvalRunRow {
  id: string;
  user_id: string;
  eval_id: string;
  agent_id: string;
  status: EvalRunStatus;
  score: number | null;
  results: string | null;
  model: string | null;
  cost_micros: string | number | null;
  error: string | null;
  created_at: string;
  finished_at: string | null;
}

export interface EvalRunDTO {
  id: string;
  eval_id: string;
  agent_id: string;
  status: EvalRunStatus;
  score: number | null;
  results: CaseResult[];
  summary: ReturnType<typeof aggregateScores>;
  model: string | null;
  cost_micros: number;
  error: string | null;
  created_at: string;
  finished_at: string | null;
}

export function toEvalRunDTO(r: EvalRunRow, opts: { withResults?: boolean } = {}): EvalRunDTO {
  const results = parseResults(r.results);
  return {
    id: r.id,
    eval_id: r.eval_id,
    agent_id: r.agent_id,
    status: r.status,
    score: r.score == null ? null : Number(r.score),
    results: opts.withResults === false ? [] : results,
    summary: aggregateScores(results),
    model: r.model,
    cost_micros: Number(r.cost_micros ?? 0) || 0,
    error: r.error,
    created_at: r.created_at,
    finished_at: r.finished_at,
  };
}

/** Sandboxed runs never consume more than this many model turns per case. */
const SANDBOX_MAX_TURNS = 6;

function summarize(value: unknown, max = 1500): string {
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

export interface SandboxCaseResult {
  output: string;
  transcript: TranscriptEntry[];
  costMicros: number;
  turns: number;
  model: string | null;
}

/** Run one case through the agent in sandbox mode. */
export async function runSandboxCase(agent: AgentRow, userId: string, evalRunId: string, c: EvalCase): Promise<SandboxCaseResult> {
  ensureToolsLoaded();
  const tools = listTools({ names: parseAgentToolNames(agent.tools) }).slice(0, RUN_LIMITS.maxToolsPerRun);
  const ctx: ToolContext = { userId, runId: `eval:${evalRunId}`, agentId: agent.id, autonomy: "draft" };
  const maxTurns = Math.min(resolveMaxSteps(agent.max_steps), SANDBOX_MAX_TURNS);

  const system =
    (await buildSystemPrompt(agent, tools, "draft", c.input)) +
    "\n\n## Evaluation sandbox\nThis is a test run. Write actions are simulated: a tool result marked `simulated` means the action was recorded but not applied. Do not retry simulated actions; proceed as if they succeeded.";
  const messages: RouterMessage[] = [
    { role: "system", content: system },
    { role: "user", content: c.input },
  ];

  const transcript: TranscriptEntry[] = [];
  let costMicros = 0;
  let turns = 0;
  let model: string | null = null;
  let lastText: string | null = null;

  const handleCall = async (call: LlmToolCall): Promise<RouterMessage> => {
    const reply = (content: string): RouterMessage => ({ role: "tool", tool_call_id: call.id, content });
    const spec = getTool(call.name);
    if (!spec) {
      transcript.push({ kind: "note", name: call.name, output: "unknown tool" });
      return reply(JSON.stringify({ ok: false, error: `Unknown tool "${call.name}". Use only the tools listed.` }));
    }
    const rawArgs = call.arguments?.trim() ? parseModelJson(call.arguments) : {};
    if (rawArgs === null) {
      transcript.push({ kind: "note", name: spec.name, input: call.arguments, output: "arguments were not valid JSON" });
      return reply(JSON.stringify({ ok: false, error: "Arguments were not valid JSON. Send a JSON object." }));
    }
    const parsed = spec.input.safeParse(rawArgs);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
      transcript.push({ kind: "note", name: spec.name, input: summarize(rawArgs), output: `invalid arguments — ${issues}` });
      return reply(JSON.stringify({ ok: false, error: `Invalid arguments: ${issues}` }));
    }
    const input = parsed.data;

    // Sandbox: anything that would write (or pause for approval under draft) is recorded, not executed.
    if (spec.scope === "write" || needsApproval(spec, input, ctx)) {
      let preview: string;
      try {
        preview = spec.preview ? spec.preview(input) : summarize(input, 300);
      } catch {
        preview = summarize(input, 300);
      }
      transcript.push({ kind: "would_call", name: spec.name, input: summarize(input, 1000), output: preview });
      return reply(JSON.stringify({ ok: true, simulated: true, summary: `Sandbox: would call ${spec.name} — ${preview}. Treated as done.` }));
    }

    const started = Date.now();
    const result = await executeTool(spec, ctx, input);
    transcript.push({
      kind: "tool",
      name: spec.name,
      input: summarize(input, 1000),
      output: result.ok ? summarize(result.data !== undefined ? result.data : result.summary) : `error: ${result.error ?? result.summary}`,
      ms: Date.now() - started,
    });
    return reply(toolResultContent(result));
  };

  while (turns < maxTurns) {
    const budget = await assertBudget(userId);
    const started = Date.now();
    const result = await completeWithTools(messages, { tools, model: agent.model, allowlist: budget.allowlist });
    turns++;
    model = model ?? `${result.provider}/${result.model}`;
    costMicros += await recordUsage(userId, {
      runId: evalRunId,
      feature: "other",
      provider: result.provider,
      model: result.model,
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
    });
    transcript.push({
      kind: "llm",
      name: `${result.provider}/${result.model}`,
      input: `turn ${turns}`,
      output: summarize(
        result.toolCalls.length > 0
          ? { content: result.content, tool_calls: result.toolCalls.map((t) => ({ name: t.name, arguments: t.arguments })) }
          : result.content ?? ""
      ),
      ms: Date.now() - started,
    });

    if (result.toolCalls.length === 0) {
      return { output: (result.content ?? "").trim(), transcript, costMicros, turns, model };
    }
    lastText = result.content;
    messages.push({
      role: "assistant",
      content: result.content,
      tool_calls: result.toolCalls.map((t) => ({ id: t.id, type: "function" as const, function: { name: t.name, arguments: t.arguments } })),
    });
    for (const call of result.toolCalls) messages.push(await handleCall(call));
  }

  transcript.push({ kind: "note", name: "step_limit", output: `Reached the sandbox turn limit (${maxTurns}).` });
  return { output: lastText?.trim() || `Stopped after ${maxTurns} turns without a final answer.`, transcript, costMicros, turns, model };
}

// ── persistence ──────────────────────────────────────────────────────────────

export async function getEval(userId: string, evalId: string): Promise<EvalRow | null> {
  return queryOne<EvalRow>(`SELECT * FROM agent_evals WHERE id = $1 AND user_id = $2`, [evalId, userId]);
}

export async function getEvalRun(userId: string, runId: string): Promise<EvalRunRow | null> {
  return queryOne<EvalRunRow>(`SELECT * FROM agent_eval_runs WHERE id = $1 AND user_id = $2`, [runId, userId]);
}

export async function listEvalRuns(userId: string, evalId: string, limit = 20): Promise<EvalRunRow[]> {
  return query<EvalRunRow>(
    `SELECT id, user_id, eval_id, agent_id, status, score, NULL AS results, model, cost_micros, error, created_at, finished_at
       FROM agent_eval_runs WHERE user_id = $1 AND eval_id = $2 ORDER BY created_at DESC LIMIT $3`,
    [userId, evalId, Math.min(Math.max(limit, 1), 100)]
  );
}

/** Create a queued run row and (by default) an `eval` job for the cron worker. */
export async function startEvalRun(userId: string, evalId: string, opts: { enqueue?: boolean } = {}): Promise<EvalRunRow> {
  const ev = await getEval(userId, evalId);
  if (!ev) throw new Error("Eval not found");
  if (parseCases(ev.cases).length === 0) throw new Error("Add at least one case before running");
  const id = randomUUID();
  await query(
    `INSERT INTO agent_eval_runs (id, user_id, eval_id, agent_id, status, cost_micros) VALUES ($1, $2, $3, $4, 'queued', 0)`,
    [id, userId, evalId, ev.agent_id]
  );
  if (opts.enqueue !== false) await enqueueJob(userId, { kind: "eval", evalRunId: id }, { maxAttempts: 1 });
  const row = await getEvalRun(userId, id);
  if (!row) throw new Error("Eval run vanished after insert");
  return row;
}

function errorMessage(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 2000);
}

/** Execute a queued eval run to completion. Safe to call from the cron worker or inline. */
export async function executeEvalRun(evalRunId: string): Promise<EvalRunRow | null> {
  const run = await queryOne<EvalRunRow>(`SELECT * FROM agent_eval_runs WHERE id = $1`, [evalRunId]);
  if (!run) return null;
  if (run.status === "done" || run.status === "failed") return run;

  const ev = await getEval(run.user_id, run.eval_id);
  const agent = ev ? await loadAgent(run.user_id, ev.agent_id) : null;
  const cases = ev ? parseCases(ev.cases) : [];

  const fail = async (error: string) => {
    await query(`UPDATE agent_eval_runs SET status = 'failed', error = $2, finished_at = NOW() WHERE id = $1`, [run.id, error]);
    return getEvalRun(run.user_id, run.id);
  };
  if (!ev) return fail("eval not found");
  if (!agent) return fail("agent not found");
  if (cases.length === 0) return fail("eval has no cases");

  await query(`UPDATE agent_eval_runs SET status = 'running', error = NULL WHERE id = $1`, [run.id]);

  const results: CaseResult[] = [];
  let totalCost = 0;
  let model: string | null = null;

  try {
    for (let idx = 0; idx < cases.length; idx++) {
      const c = cases[idx];
      let caseResult: CaseResult;
      try {
        const sandbox = await runSandboxCase(agent, run.user_id, run.id, c);
        model = model ?? sandbox.model;
        totalCost += sandbox.costMicros;
        let verdict: { score: number; reasons: string } | null = null;
        let judgeError: string | null = null;
        try {
          verdict = await judgeCase(run.user_id, run.id, {
            input: c.input,
            expected: c.expected ?? null,
            rubric: c.rubric ?? null,
            output: sandbox.output,
            transcript: sandbox.transcript,
          });
        } catch (err) {
          judgeError = errorMessage(err);
        }
        caseResult = {
          idx,
          input: c.input,
          expected: c.expected ?? null,
          rubric: c.rubric ?? null,
          output: sandbox.output,
          score: verdict?.score ?? null,
          reasons: verdict?.reasons ?? (judgeError ? `Judge failed: ${judgeError}` : "Judge returned no verdict."),
          transcript: sandbox.transcript,
          cost_micros: sandbox.costMicros,
          turns: sandbox.turns,
          error: judgeError,
        };
      } catch (err) {
        caseResult = {
          idx,
          input: c.input,
          expected: c.expected ?? null,
          rubric: c.rubric ?? null,
          output: "",
          score: null,
          reasons: "",
          transcript: [],
          cost_micros: 0,
          turns: 0,
          error: errorMessage(err),
        };
      }
      results.push(caseResult);
      // Persist progress so the UI can show partial results while a long eval runs.
      await query(`UPDATE agent_eval_runs SET results = $2, cost_micros = $3, model = COALESCE(model, $4) WHERE id = $1`, [
        run.id,
        JSON.stringify(results),
        totalCost,
        model,
      ]).catch(() => undefined);
    }
  } catch (err) {
    return fail(errorMessage(err));
  }

  const summary = aggregateScores(results);
  const allErrored = results.length > 0 && results.every((r) => r.error && r.score === null);
  await query(
    `UPDATE agent_eval_runs SET status = $2, score = $3, results = $4, model = $5, cost_micros = $6, error = $7, finished_at = NOW() WHERE id = $1`,
    [
      run.id,
      allErrored ? "failed" : "done",
      summary.score,
      JSON.stringify(results),
      model,
      totalCost,
      allErrored ? results[0]?.error ?? "all cases failed" : null,
    ]
  );
  return getEvalRun(run.user_id, run.id);
}
