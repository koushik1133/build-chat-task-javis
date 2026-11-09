import { principalFromCan, type RunPrincipal } from "@/lib/agents/principal";
import { z } from "zod";
import { wrapUntrusted } from "@/lib/ai/untrusted";
import { query, queryOne } from "@/lib/dsql";
import { registerTool } from "@/lib/agents/registry";
import type { ToolResult } from "@/lib/agents/types";

/** Tools for listing the user's agents and delegating work to one. */

interface AgentRow {
  id: string;
  name: string;
  role: string;
  status: string;
  autonomy_level: string | null;
  tasks_completed: number | null;
  created_at: string;
}

function fail(error: string): ToolResult {
  return { ok: false, summary: error, error };
}
function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/* ---------- agents.list ---------- */
const ListInput = z.object({});
type ListInputT = z.infer<typeof ListInput>;

registerTool<ListInputT>({
  name: "agents.list",
  module: "agents",
  description: "List the user's configured AI agents (name, role, status, autonomy) — up to 25.",
  input: ListInput,
  parameters: { type: "object", properties: {} },
  scope: "read",
  preview: () => "List agents",
  async run(ctx) {
    try {
      const rows = await query<AgentRow>(
        `SELECT id, name, role, status, autonomy_level, tasks_completed, created_at
         FROM agents WHERE user_id = $1 ORDER BY created_at DESC LIMIT 25`,
        [ctx.userId]
      );
      return { ok: true, data: rows, summary: `Found ${rows.length} agent(s)` };
    } catch (err) {
      return fail(`List failed: ${errMsg(err)}`);
    }
  },
});

/* ---------- agents.run_agent ---------- */
const RunInput = z.object({
  agent_id: z.string().min(1),
  prompt: z.string().min(1).max(4000),
});
type RunInputT = z.infer<typeof RunInput>;

type StartRunFn = (userId: string, agentId: string, opts: { prompt?: string | null; triggerKind?: "manual"; triggerRef?: string | null; principal?: RunPrincipal | null }) => Promise<string>;

registerTool<RunInputT>({
  name: "agents.run_agent",
  module: "agents",
  description: "Delegate a task to one of the user's agents by queuing a new run with the given prompt.",
  input: RunInput,
  parameters: {
    type: "object",
    properties: { agent_id: { type: "string" }, prompt: { type: "string" } },
    required: ["agent_id", "prompt"],
  },
  scope: "write",
  requiresApproval: false,
  preview: (i) => `Run agent ${i.agent_id}: ${i.prompt.slice(0, 80)}`,
  async run(ctx, input) {
    try {
      const agent = await queryOne<{ id: string; name: string }>(`SELECT id, name FROM agents WHERE id = $1 AND user_id = $2`, [
        input.agent_id,
        ctx.userId,
      ]);
      if (!agent) return fail("Agent not found");
      if (agent.id === ctx.agentId) return fail("An agent cannot delegate to itself");

      // The runner is loaded lazily so this module registers even when the
      // runtime is unavailable (e.g. partial deploys); absence is reported, not thrown.
      let startRun: StartRunFn | undefined;
      try {
        const mod = (await import("@/lib/agents/runner")) as { startRun?: StartRunFn };
        startRun = mod.startRun;
      } catch {
        startRun = undefined;
      }
      if (!startRun) return fail("Agent runtime is not available on this deployment");

      const runId = await startRun(ctx.userId, agent.id, {
        // A tainted parent must not launder customer text into an untainted child run.
        prompt: ctx.tainted ? `Delegated task (derived from untrusted content):\n${wrapUntrusted("delegated_task", input.prompt, { maxChars: 4000 })}` : input.prompt,
        triggerKind: "manual",
        triggerRef: ctx.runId || null,
        principal: ctx.can ? principalFromCan(ctx.can) : null,
      });
      return { ok: true, data: { runId, agentId: agent.id }, summary: `Queued run ${runId} for agent "${agent.name}"` };
    } catch (err) {
      return fail(`Run failed: ${errMsg(err)}`);
    }
  },
});
