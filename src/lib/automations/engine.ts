import { query, queryOne } from "@/lib/dsql";
import { emitEvent } from "@/lib/events/bus";
import { ensureToolsLoaded } from "@/lib/agents/tools/index";
import { defaultDeps, executeStep, planStep, runTool, type StepDeps, type StepEnv } from "./actions";
import { evaluateConditions } from "./conditions";
import { definitionOf, getAutomation, RUN_COLS, type AutomationRow, type RunRow } from "./store";
import { triggerMatches } from "./triggers";
import type { AutomationDefinition, RunContext, RunStatus, Step, StepResult, TestPlan } from "./types";
import { APPROVAL_RUN_PREFIX, RUN_LIMITS } from "./types";

/**
 * Execution side of the engine.
 *
 *   runQueued(limit)      claim queued runs + waiting runs whose resume_at is
 *                         due, execute steps sequentially, persist after each.
 *   resumeAutomationRun() called from approvals/decide.ts when an approval
 *                         tied to an automation run is decided.
 *   planRun()             dry-run for the test endpoint (no side effects).
 *
 * A run is `waiting` while a delay or an approval is outstanding; its
 * `step_index` already points at the step to continue with (delay) or at the
 * gated step (approval), and `step_results` is the audit trail.
 */

type Deps = StepDeps;

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

async function persistProgress(run: RunRow, results: StepResult[], stepIndex: number, context: RunContext): Promise<void> {
  await query(`UPDATE automation_runs SET step_results = $2, step_index = $3, context = $4 WHERE id = $1`, [run.id, JSON.stringify(results), stepIndex, JSON.stringify(context)]);
}

async function finish(run: RunRow, status: Extract<RunStatus, "done" | "failed" | "skipped">, error: string | null, context: RunContext, results: StepResult[]): Promise<void> {
  await query(`UPDATE automation_runs SET status = $2, error = $3, finished_at = NOW(), resume_at = NULL, approval_id = NULL, step_results = $4, context = $5 WHERE id = $1`, [
    run.id,
    status,
    error,
    JSON.stringify(results),
    JSON.stringify(context),
  ]);
  if (status === "failed") {
    await query(`UPDATE automations SET run_count = COALESCE(run_count, 0) + 1, error_count = COALESCE(error_count, 0) + 1, last_run_at = NOW(), last_run = NOW(), last_error = $2 WHERE id::text = $1`, [
      run.automation_id,
      (error ?? "failed").slice(0, 500),
    ]).catch(() => undefined);
  } else {
    await query(`UPDATE automations SET run_count = COALESCE(run_count, 0) + 1, last_run_at = NOW(), last_run = NOW(), last_error = NULL WHERE id::text = $1`, [run.automation_id]).catch(() => undefined);
  }
  void emitEvent(run.user_id, {
    type: status === "failed" ? "automation.run_failed" : "automation.run_finished",
    entity: "automation_run",
    entityId: run.id,
    data: { automation_id: run.automation_id, run_id: run.id, status, event_type: context.event.type, error: error ?? undefined, steps: results.length },
  });
}

function indexOfStep(steps: Step[], id: string): number {
  return steps.findIndex((s) => s.id === id);
}

/**
 * Execute a claimed run from its current `step_index`. Returns the final
 * status for this tick (`waiting` when paused).
 */
export async function executeRun(run: RunRow, automation: AutomationRow, deps: Deps = defaultDeps): Promise<RunStatus> {
  const def = definitionOf(automation);
  const context = parseJson<RunContext | null>(run.context, null);
  if (!context) {
    await finish(run, "failed", "run has no context", { event: { id: "", type: "", entity: "", entity_id: "", data: {}, created_at: "" }, entity: null, org: { id: run.user_id }, automation: { id: automation.id, name: def.name }, steps: {}, now: new Date().toISOString() }, []);
    return "failed";
  }
  const results = parseJson<StepResult[]>(run.step_results, []);
  const env: StepEnv = { dataId: run.user_id, runId: run.id, automation: { id: automation.id, name: def.name, autonomy: def.autonomy }, context };
  let idx = Number(run.step_index ?? 0);
  let executed = 0;

  while (idx < def.steps.length) {
    if (executed >= RUN_LIMITS.maxSteps) {
      await finish(run, "failed", `step budget of ${RUN_LIMITS.maxSteps} exceeded`, context, results);
      return "failed";
    }
    const step = def.steps[idx];
    const started = Date.now();
    let exec;
    try {
      exec = await executeStep(step, env, deps);
    } catch (err) {
      exec = { status: "failed" as const, summary: `${step.kind} step crashed`, error: err instanceof Error ? err.message : String(err) };
    }
    executed++;
    const result: StepResult = { step_id: step.id, kind: step.kind, name: step.name, status: exec.status, summary: exec.summary, output: exec.output, error: exec.error, ms: Date.now() - started, at: new Date().toISOString() };
    results.push(result);
    if (exec.output !== undefined) context.steps[step.id] = exec.output;

    if (exec.status === "failed") {
      await finish(run, "failed", `${step.name ?? step.id}: ${exec.error ?? exec.summary}`, context, results);
      return "failed";
    }

    if (exec.status === "waiting") {
      if (exec.resumeAt) {
        // Delay: continue with the next step when due.
        await query(`UPDATE automation_runs SET status = 'waiting', resume_at = $2, approval_id = NULL, step_results = $3, step_index = $4, context = $5 WHERE id = $1`, [
          run.id,
          exec.resumeAt.toISOString(),
          JSON.stringify(results),
          idx + 1,
          JSON.stringify(context),
        ]);
      } else {
        // Approval: stay on this step; resumeAutomationRun() finishes it.
        await query(`UPDATE automation_runs SET status = 'waiting', resume_at = NULL, approval_id = $2, step_results = $3, step_index = $4, context = $5 WHERE id = $1`, [
          run.id,
          exec.approvalId ?? null,
          JSON.stringify(results),
          idx,
          JSON.stringify(context),
        ]);
      }
      return "waiting";
    }

    // ok | skipped → follow `next`
    if (exec.next === "end") {
      idx = def.steps.length;
    } else if (exec.next) {
      const target = indexOfStep(def.steps, exec.next);
      if (target < 0) {
        await finish(run, "failed", `branch target "${exec.next}" not found`, context, results);
        return "failed";
      }
      idx = target;
    } else {
      idx++;
    }
    await persistProgress(run, results, idx, context);
  }

  await finish(run, "done", null, context, results);
  return "done";
}

/** `started_at` is the lease timestamp: every claim (first start or resume) renews it. */
async function claim(id: string): Promise<RunRow | null> {
  return queryOne<RunRow>(
    `UPDATE automation_runs r SET status = 'running', started_at = NOW()
      WHERE r.id = $1 AND (r.status = 'queued' OR (r.status = 'waiting' AND r.resume_at IS NOT NULL AND r.resume_at <= NOW()))
      RETURNING ${RUN_COLS}`,
    [id]
  );
}

/**
 * Runs stuck in `running` past the lease (worker crashed or the serverless
 * function was killed mid-run) are failed with a message so `requeueRun` can
 * retry them; nothing else ever touches a `running` row.
 */
async function reapStaleRunning(): Promise<number> {
  const rows = await query<{ id: string; user_id: string; automation_id: string }>(
    `UPDATE automation_runs SET status = 'failed', error = $2, finished_at = NOW(), resume_at = NULL, approval_id = NULL
      WHERE status = 'running' AND COALESCE(started_at, created_at) < NOW() - ($1 || ' minutes')::interval
      RETURNING id, user_id, automation_id`,
    [String(RUN_LIMITS.runningLeaseMinutes), `run exceeded the ${RUN_LIMITS.runningLeaseMinutes} minute execution lease (worker lost); retry from the run drawer`]
  ).catch(() => []);
  for (const r of rows) {
    void emitEvent(r.user_id, { type: "automation.run_failed", entity: "automation_run", entityId: r.id, data: { automation_id: r.automation_id, run_id: r.id, status: "failed", error: "execution lease expired" } });
  }
  return rows.length;
}

/**
 * Approvals decided outside `decideApproval()` (the inbox's expiry sweep, or
 * a TTL that lapsed with nobody looking) would otherwise leave their run
 * `waiting` forever. Expire overdue automation approvals here and finish the
 * runs whose approval is no longer pending.
 */
async function settleDecidedApprovals(limit: number, deps: Deps): Promise<number> {
  await query(`UPDATE approvals SET status = 'expired', decided_at = NOW() WHERE status = 'pending' AND run_id LIKE $1 AND expires_at IS NOT NULL AND expires_at < NOW()`, [`${APPROVAL_RUN_PREFIX}%`]).catch(() => undefined);
  const rows = await query<{ run_id: string; user_id: string; approval_id: string; status: string; tool_name: string; input: string | null }>(
    `SELECT r.id AS run_id, r.user_id, a.id AS approval_id, a.status, a.tool_name, a.input
       FROM automation_runs r JOIN approvals a ON a.id = r.approval_id
      WHERE r.status = 'waiting' AND r.approval_id IS NOT NULL AND a.status <> 'pending'
      ORDER BY a.decided_at ASC NULLS FIRST LIMIT $1`,
    [Math.min(Math.max(limit, 1), 500)]
  ).catch(() => []);
  let settled = 0;
  for (const r of rows) {
    try {
      const status = await resumeAutomationRun(r.user_id, r.run_id, { id: r.approval_id, status: r.status, tool_name: r.tool_name, input: r.input }, deps);
      if (status) settled++;
    } catch (err) {
      console.error(`[automations] settling approval ${r.approval_id} for run ${r.run_id} failed:`, err);
    }
  }
  return settled;
}

export interface RunQueuedResult {
  claimed: number;
  done: number;
  waiting: number;
  failed: number;
  /** Runs continued because their approval was decided/expired outside decideApproval(). */
  resumed: number;
  /** Runs failed because their execution lease lapsed. */
  reaped: number;
}

/** Execute due runs (oldest first). Safe to call concurrently: claims are conditional updates. */
export async function runQueued(limit = 50, deps: Deps = defaultDeps): Promise<RunQueuedResult> {
  ensureToolsLoaded();
  const out: RunQueuedResult = { claimed: 0, done: 0, waiting: 0, failed: 0, resumed: 0, reaped: 0 };
  out.reaped = await reapStaleRunning();
  out.resumed = await settleDecidedApprovals(limit, deps);
  const due = await query<{ id: string }>(
    `SELECT id FROM automation_runs WHERE status = 'queued' OR (status = 'waiting' AND resume_at IS NOT NULL AND resume_at <= NOW()) ORDER BY created_at ASC LIMIT $1`,
    [Math.min(Math.max(limit, 1), 500)]
  );
  const autoCache = new Map<string, AutomationRow | null>();
  for (const { id } of due) {
    const run = await claim(id);
    if (!run) continue;
    out.claimed++;
    let automation = autoCache.get(run.automation_id);
    if (automation === undefined) {
      automation = await getAutomation(run.user_id, run.automation_id);
      autoCache.set(run.automation_id, automation);
    }
    if (!automation) {
      await query(`UPDATE automation_runs SET status = 'failed', error = 'automation deleted', finished_at = NOW() WHERE id = $1`, [run.id]);
      out.failed++;
      continue;
    }
    try {
      const status = await executeRun(run, automation, deps);
      if (status === "done") out.done++;
      else if (status === "waiting") out.waiting++;
      else out.failed++;
    } catch (err) {
      console.error(`[automations] run ${run.id} crashed:`, err);
      await query(`UPDATE automation_runs SET status = 'failed', error = $2, finished_at = NOW() WHERE id = $1`, [run.id, (err instanceof Error ? err.message : String(err)).slice(0, 500)]).catch(() => undefined);
      out.failed++;
    }
  }
  return out;
}

/* ─── approvals hook ───────────────────────────────────────────────────── */

export interface DecidedApproval {
  id: string;
  status: string;
  tool_name: string;
  input: string | null;
}

/**
 * Continue a run that paused on `approval`. Approved tool steps execute now
 * with the (possibly edited) input from the approvals row; rejected or
 * expired approvals end the run as `skipped`. The rest of the steps run
 * inline so the operator sees the outcome immediately.
 */
export async function resumeAutomationRun(dataId: string, runId: string, approval: DecidedApproval, deps: Deps = defaultDeps): Promise<RunStatus | null> {
  ensureToolsLoaded();
  const run = await queryOne<RunRow>(
    `UPDATE automation_runs r SET status = 'running', started_at = NOW() WHERE r.id = $1 AND r.user_id = $2 AND r.status = 'waiting' AND r.approval_id = $3 RETURNING ${RUN_COLS}`,
    [runId, dataId, approval.id]
  );
  if (!run) return null;
  const automation = await getAutomation(dataId, run.automation_id);
  const context = parseJson<RunContext | null>(run.context, null);
  const results = parseJson<StepResult[]>(run.step_results, []);
  if (!automation || !context) {
    await query(`UPDATE automation_runs SET status = 'failed', error = 'automation or context missing', finished_at = NOW() WHERE id = $1`, [run.id]);
    return "failed";
  }
  const def = definitionOf(automation);
  const idx = Number(run.step_index ?? 0);
  const step = def.steps[idx];
  const env: StepEnv = { dataId, runId: run.id, automation: { id: automation.id, name: def.name, autonomy: def.autonomy }, context };
  const started = Date.now();

  if (approval.status !== "approved") {
    const why = approval.status === "expired" ? "Approval expired" : "Rejected by operator";
    results.push({ step_id: step?.id ?? "approval", kind: step?.kind ?? "approval", name: step?.name, status: "skipped", summary: why, error: why, ms: Date.now() - started, at: new Date().toISOString() });
    await finish(run, "skipped", why, context, results);
    return "skipped";
  }

  if (!step) {
    await finish(run, "done", null, context, results);
    return "done";
  }

  let exec;
  if (step.kind === "tool") {
    const input = parseJson<unknown>(approval.input, {});
    exec = await runTool(env, approval.tool_name, input, deps, true);
  } else {
    exec = { status: "ok" as const, summary: "Approved", output: { approved: true, approval_id: approval.id } };
  }
  results.push({ step_id: step.id, kind: step.kind, name: step.name, status: exec.status, summary: exec.summary, output: exec.output, error: exec.error, ms: Date.now() - started, at: new Date().toISOString() });
  if (exec.output !== undefined) context.steps[step.id] = exec.output;
  if (exec.status === "failed") {
    await finish(run, "failed", `${step.name ?? step.id}: ${exec.error ?? exec.summary}`, context, results);
    return "failed";
  }
  // Continue with the remaining steps in the same tick.
  const next: RunRow = { ...run, step_index: idx + 1, step_results: JSON.stringify(results), context: JSON.stringify(context), approval_id: null };
  await query(`UPDATE automation_runs SET approval_id = NULL, step_index = $2, step_results = $3, context = $4 WHERE id = $1`, [run.id, idx + 1, JSON.stringify(results), JSON.stringify(context)]);
  return executeRun(next, automation, deps);
}

/* ─── dry run ──────────────────────────────────────────────────────────── */

/** Evaluate trigger + conditions and render every step without executing anything. */
export function planRun(def: AutomationDefinition, automationId: string, context: RunContext, deps: Pick<Deps, "getTool" | "needsApproval"> = defaultDeps): TestPlan {
  ensureToolsLoaded();
  let matched = true;
  let reason: string | null = null;
  if (def.trigger_type === "event") {
    if (!triggerMatches({ ...def, enabled: true }, context.event, automationId)) {
      matched = false;
      reason = `trigger "${def.trigger_config.event_type ?? ""}" does not match event ${context.event.type}`;
    }
  }
  if (matched && !evaluateConditions(def.conditions, context)) {
    matched = false;
    reason = "conditions did not match the sample event";
  }
  const env: StepEnv = { dataId: context.org.id, runId: "dry-run", automation: { id: automationId, name: def.name, autonomy: def.autonomy }, context };
  const steps = def.steps.map((s) => planStep(s, env, deps));
  return { matched, reason, context, steps };
}
