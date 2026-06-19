import { NextResponse } from "next/server";
import { requireUser } from "@/lib/supabase/server";
import { runAgentJob } from "@/lib/agent-runner";
import { queryOne } from "@/lib/dsql";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  let user;
  try {
    ({ user } = await requireUser());
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { id } = await ctx.params;

  try {
    const runResult = await runAgentJob(user.id, id, {
      workflowName: "Manual Run",
    });

    if (!runResult) {
      return NextResponse.json({ error: "Agent not found or run failed" }, { status: 404 });
    }

    // Create an in-app notification that will match the 'agent' path heuristic.
    const notification = await queryOne(
      `INSERT INTO notifications (user_id, title, body)
       VALUES ($1, $2, $3)
       RETURNING id, title, body, read, created_at`,
      [
        user.id,
        `Agent "${runResult.agent.name}" Completed Run`,
        `The manual run of agent "${runResult.agent.name}" finished. Click here to see the agent work output.`
      ]
    ).catch((err) => {
      console.error("Failed to insert notification:", err);
      return null;
    });

    return NextResponse.json({
      success: true,
      run: runResult,
      notification,
    });
  } catch (err) {
    console.error("Failed to run agent:", err);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
