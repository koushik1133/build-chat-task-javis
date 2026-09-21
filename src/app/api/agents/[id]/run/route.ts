import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/supabase/server";
import { runAgentJob } from "@/lib/agent-runner";
import { AgentNotFoundError, startRun } from "@/lib/agents/runner";
import { llmNotConfiguredResponse } from "@/lib/llm-response";
import { queryOne } from "@/lib/dsql";

export const runtime = "nodejs";
export const maxDuration = 60;

const bodySchema = z.object({
  prompt: z.string().max(20_000).nullable().optional(),
});

/**
 * POST /api/agents/:id/run        → 202 { runId } (worker executes it)
 * POST /api/agents/:id/run?sync=1 → runs inline and returns the output (legacy UI)
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  let user;
  try {
    ({ user } = await requireUser());
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { id } = await ctx.params;
  const url = new URL(req.url);
  const sync = url.searchParams.get("sync") === "1";

  const raw = await req.text().catch(() => "");
  let prompt: string | null = null;
  if (raw.trim()) {
    let json: unknown;
    try { json = JSON.parse(raw); } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }
    const parsed = bodySchema.safeParse(json);
    if (!parsed.success) return NextResponse.json({ error: "Invalid body" }, { status: 400 });
    prompt = parsed.data.prompt ?? null;
  }

  if (!sync) {
    try {
      const runId = await startRun(user.id, id, { prompt, triggerKind: "manual", workflowName: "Manual Run" });
      return NextResponse.json({ success: true, runId, status: "queued" }, { status: 202 });
    } catch (err) {
      if (err instanceof AgentNotFoundError) return NextResponse.json({ error: "Agent not found" }, { status: 404 });
      console.error("[agents/run] failed to queue:", err);
      return NextResponse.json({ error: "Failed to queue run" }, { status: 500 });
    }
  }

  try {
    const runResult = await runAgentJob(user.id, id, { prompt, workflowName: "Manual Run" });
    if (!runResult) {
      return NextResponse.json({ error: "Agent not found or run failed" }, { status: 404 });
    }

    const title =
      runResult.status === "awaiting_approval"
        ? `Agent "${runResult.agent.name}" needs your approval`
        : `Agent "${runResult.agent.name}" Completed Run`;
    const body =
      runResult.status === "awaiting_approval"
        ? runResult.output
        : `The manual run of agent "${runResult.agent.name}" finished. Click here to see the agent work output.`;

    const notification = await queryOne(
      `INSERT INTO notifications (user_id, title, body)
       VALUES ($1, $2, $3)
       RETURNING id, title, body, read, created_at`,
      [user.id, title, body]
    ).catch((err) => {
      console.error("Failed to insert notification:", err);
      return null;
    });

    return NextResponse.json({ success: true, run: runResult, notification });
  } catch (err) {
    const notConfigured = llmNotConfiguredResponse(err);
    if (notConfigured) return notConfigured;
    console.error("[agents/run] error:", err);
    return NextResponse.json({ error: "Agent run failed" }, { status: 500 });
  }
}
