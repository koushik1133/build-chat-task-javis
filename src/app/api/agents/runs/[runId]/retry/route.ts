import { principalFromScope } from "@/lib/agents/principal";
import { NextResponse } from "next/server";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { AgentNotFoundError, getRun, startRun } from "@/lib/agents/runner";

export const runtime = "nodejs";

/** POST /api/agents/runs/:runId/retry — queue a fresh run with the same prompt. */
export async function POST(_req: Request, ctx: { params: Promise<{ runId: string }> }) {
  let scope;
  try { scope = await requireScope({ area: "agents", edit: true }); }
  catch (err) { return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 }); }
  const { runId } = await ctx.params;

  const run = await getRun(runId, scope.dataId);
  if (!run) return NextResponse.json({ error: "not found" }, { status: 404 });

  try {
    const newRunId = await startRun(scope.dataId, run.agent_id, {
      prompt: run.prompt,
      triggerKind: "manual",
      triggerRef: run.id,
      automationId: run.automation_id,
      principal: principalFromScope(scope),
      workflowName: run.workflow_name ? `${run.workflow_name} (retry)` : "Retry",
    });
    return NextResponse.json({ runId: newRunId, retryOf: run.id }, { status: 202 });
  } catch (err) {
    if (err instanceof AgentNotFoundError) return NextResponse.json({ error: "agent no longer exists" }, { status: 404 });
    console.error("[agents/runs/retry] failed:", err);
    return NextResponse.json({ error: "failed to queue retry" }, { status: 500 });
  }
}
