import { queryOne } from "@/lib/dsql";
import { startRun } from "@/lib/agents/runner";
import { ROUTES } from "@/lib/public-api/registry";
import { op, libCall, mustFind } from "@/lib/public-api/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = op(ROUTES.triggerAgentRun, async ({ principal, params, body }) => {
  const agent = mustFind(await queryOne<{ id: string }>(`SELECT id FROM agents WHERE id::text = $1 AND user_id = $2 AND deleted_at IS NULL`, [params.id, principal.dataId]), "Agent");
  const runId = await libCall(() => startRun(principal.dataId, agent.id, { prompt: body.prompt ?? null, triggerKind: "manual", triggerRef: `api_key:${principal.keyId}` }));
  return { data: { run_id: runId, agent_id: agent.id, status: "queued" as const }, status: 201 };
});
