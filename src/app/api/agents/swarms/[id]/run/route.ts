import { NextRequest } from "next/server";
import { queryOne } from "@/lib/dsql";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { principalFromScope } from "@/lib/agents/principal";
import { runAgentJob } from "@/lib/agent-runner";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    let scope;
    try {
      scope = await requireScope({ area: "agents", edit: true });
    } catch (err) {
      return scopeErrorResponse(err) ?? new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
    }

    const { id } = await params;
    const rawBody = await req.json().catch(() => null);
    if (!rawBody || typeof rawBody !== "object") return Response.json({ error: "Invalid JSON body" }, { status: 400 });
    const { input } = rawBody;

    const swarm = await queryOne<{ nodes: string }>(
      `SELECT nodes FROM agent_swarms WHERE id = $1 AND user_id = $2`,
      [id, scope.dataId]
    );

    if (!swarm) {
      return new Response(JSON.stringify({ error: "Swarm not found" }), { status: 404 });
    }

    let nodes = [];
    try {
      nodes = JSON.parse(swarm.nodes);
    } catch {}

    // Sort by order
    nodes.sort((a: { order: number }, b: { order: number }) => a.order - b.order);

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        try {
          let currentContext = input || "";

          // Create swarm run record
          const runId = crypto.randomUUID();
          await queryOne(
            `INSERT INTO agent_swarm_runs (id, swarm_id, user_id, status, started_at) VALUES ($1, $2, $3, 'running', NOW()) RETURNING id`,
            [runId, id, scope.dataId]
          );

          for (let i = 0; i < nodes.length; i++) {
            const node = nodes[i];
            
            // Get agent
            const agent = await queryOne<{ id: string; name: string; template_id: string }>(
              `SELECT id, name, template_id FROM agents WHERE id = $1 AND user_id = $2`,
              [node.agentId, scope.dataId]
            );

            if (!agent) {
              throw new Error(`Agent not found for node ${i}`);
            }

            const startTime = Date.now();
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'step_start', agentName: agent.name, order: node.order })}\n\n`));

            // Run agent
            const customPrompt = node.customPrompt ? `\n\nAdditional Instructions: ${node.customPrompt}` : "";
            const taskPrompt = `Previous context / input: ${currentContext}${customPrompt}`;
            
            const result = await runAgentJob(
              scope.dataId,
              agent.id,
              {
                prompt: taskPrompt,
                workflowName: 'swarm',
                principal: principalFromScope(scope)
              }
            );

            if (!result) {
              throw new Error(`Agent ${agent.name} returned null`);
            }

            const durationMs = Date.now() - startTime;
            currentContext = result.output; // pass output to next agent

            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'step_done', agentName: agent.name, output: result.output, duration_ms: durationMs })}\n\n`));
          }

          // Complete
          await queryOne(
            `UPDATE agent_swarm_runs SET status = 'completed', completed_at = NOW(), final_output = $1 WHERE id = $2 RETURNING id`,
            [currentContext, runId]
          );

          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'complete', totalSteps: nodes.length, summary: currentContext })}\n\n`));
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        } catch (err: unknown) {
          const e = err as Error;
          console.error("Swarm node execution error:", e);
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'error', error: 'Swarm execution failed' })}\n\n`));
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        } finally {
          controller.close();
        }
      }
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    });
  } catch (err) {
    console.error("Swarm Run Error:", err);
    return new Response(JSON.stringify({ error: "Internal Server Error" }), { status: 500 });
  }
}
