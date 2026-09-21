import { NextRequest } from "next/server";
import { queryOne } from "@/lib/dsql";
import { streamChat } from "@/lib/llm";
import { llmNotConfiguredResponse } from "@/lib/llm-response";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";

export async function POST(req: NextRequest) {
  try {
    let scope;
    try {
      scope = await requireScope({ area: "reports", edit: true });
    } catch (err) {
      return scopeErrorResponse(err) ?? new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
    }

    const rawBody = await req.json().catch(() => null);
    if (!rawBody || typeof rawBody !== "object") return Response.json({ error: "Invalid JSON body" }, { status: 400 });
    const { question } = rawBody;
    if (!question) {
      return new Response(JSON.stringify({ error: "Missing question" }), { status: 400 });
    }

    // Fetch key metrics
    const [leads, agents, runs, tasks, doneTasks, automations, strategies] = await Promise.all([
      queryOne<{ count: string }>(`SELECT COUNT(*) as count FROM site_leads WHERE user_id = $1`, [scope.dataId]),
      queryOne<{ count: string }>(`SELECT COUNT(*) as count FROM agents WHERE user_id = $1 AND status = 'active'`, [scope.dataId]),
      queryOne<{ count: string }>(`SELECT COUNT(*) as count FROM agent_runs WHERE user_id = $1`, [scope.dataId]),
      queryOne<{ count: string }>(`SELECT COUNT(*) as count FROM tasks WHERE user_id = $1`, [scope.dataId]),
      queryOne<{ count: string }>(`SELECT COUNT(*) as count FROM tasks WHERE user_id = $1 AND done = true`, [scope.dataId]),
      queryOne<{ count: string }>(`SELECT COUNT(*) as count FROM automations WHERE user_id = $1`, [scope.dataId]),
      queryOne<{ count: string }>(`SELECT COUNT(*) as count FROM strategies WHERE user_id = $1`, [scope.dataId]),
    ]);

    const metricsContext = `
    Total Leads Captured: ${leads?.count || 0}
    Active AI Agents: ${agents?.count || 0}
    Total Agent Runs: ${runs?.count || 0}
    Total Tasks: ${tasks?.count || 0}
    Completed Tasks: ${doneTasks?.count || 0}
    Active Automations: ${automations?.count || 0}
    Strategies Created: ${strategies?.count || 0}
    `;

    const systemPrompt = `You are a business intelligence consultant AI for KernelHub. You have access to the user's real business metrics. 
Provide actionable, specific insights based on these metrics. 
Format your response exactly as:
**Summary**: (1-2 sentences)
**Key Findings**: (3 bullet points)
**Recommendation**: (one clear action to take)
**Priority**: (High/Medium/Low)

User metrics context: 
${metricsContext}`;

    const stream = await streamChat([
      { role: "system", content: systemPrompt },
      { role: "user", content: question }
    ]);

    const encoder = new TextEncoder();
    const customStream = new ReadableStream({
      async start(controller) {
        for await (const chunk of stream) {
          const content = chunk.choices[0]?.delta?.content || "";
          if (content) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ chunk: content })}\n\n`));
          }
        }
        controller.enqueue(encoder.encode('data: [DONE]\\n\\n'));
        controller.close();
      }
    });

    return new Response(customStream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    });
  } catch (err) {
    const notConfigured = llmNotConfiguredResponse(err);
    if (notConfigured) return notConfigured;
    console.error("Analytics Ask Error:", err);
    return new Response(JSON.stringify({ error: "Internal Server Error" }), { status: 500 });
  }
}
