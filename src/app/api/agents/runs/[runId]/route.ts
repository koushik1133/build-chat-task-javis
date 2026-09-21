import { NextResponse } from "next/server";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { query, queryOne } from "@/lib/dsql";
import { CHECKPOINT_STEP_NAME } from "@/lib/agents/loop";
import { cancelRun } from "@/lib/agents/runner";

export const runtime = "nodejs";

type StepRow = {
  id: string;
  idx: number;
  kind: string;
  name: string | null;
  input: string | null;
  output: string | null;
  tokens: number | null;
  ms: number | null;
  created_at: string;
};

export async function GET(_req: Request, ctx: { params: Promise<{ runId: string }> }) {
  let scope;
  try { scope = await requireScope({ area: "agents", edit: false }); }
  catch (err) { return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 }); }
  const { runId } = await ctx.params;

  const run = await queryOne(
    `SELECT r.id, r.agent_id, r.workflow_name, r.prompt, r.output, r.status, r.trigger_kind, r.trigger_ref,
            r.error, r.tokens_in, r.tokens_out, r.cost_micros, r.started_at, r.finished_at, r.attempt, r.created_at,
            a.name AS agent_name, a.role AS agent_role
     FROM agent_runs r
     LEFT JOIN agents a ON a.id = r.agent_id
     WHERE r.id = $1 AND r.user_id = $2`,
    [runId, scope.dataId]
  ).catch(() => null);
  if (!run) return NextResponse.json({ error: "not found" }, { status: 404 });

  const rows = await query<StepRow>(
    `SELECT id, idx, kind, name, input, output, tokens, ms, created_at
     FROM agent_run_steps WHERE run_id = $1 AND user_id = $2 ORDER BY idx ASC`,
    [runId, scope.dataId]
  ).catch(() => []);

  // Checkpoints carry the full model transcript; never hand that to the client.
  const steps = rows.map((s) =>
    s.kind === "note" && s.name === CHECKPOINT_STEP_NAME ? { ...s, input: null } : s
  );

  const approvals = await query(
    `SELECT id, tool_name, preview, status, created_at, decided_at FROM approvals WHERE run_id = $1 AND user_id = $2 ORDER BY created_at ASC`,
    [runId, scope.dataId]
  ).catch(() => []);

  return NextResponse.json({ run, steps, approvals });
}

/** DELETE /api/agents/runs/:runId — cancel a queued / running / paused run. */
export async function DELETE(_req: Request, ctx: { params: Promise<{ runId: string }> }) {
  let scope;
  try { scope = await requireScope({ area: "agents", edit: true }); }
  catch (err) { return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 }); }
  const { runId } = await ctx.params;
  const ok = await cancelRun(scope.dataId, runId);
  if (!ok) return NextResponse.json({ error: "run not found or already finished" }, { status: 404 });
  return NextResponse.json({ ok: true, status: "cancelled" });
}
