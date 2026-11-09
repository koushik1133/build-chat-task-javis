import { queryOne } from "@/lib/dsql";
import { ROUTES } from "@/lib/public-api/registry";
import { op, mustFind } from "@/lib/public-api/handler";
import { agentView, AGENT_COLS, type AgentRow } from "@/lib/public-api/views";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = op(ROUTES.getAgent, async ({ principal, params }) => ({
  data: agentView(mustFind(await queryOne<AgentRow>(`SELECT ${AGENT_COLS} FROM agents WHERE id::text = $1 AND user_id = $2 AND deleted_at IS NULL`, [params.id, principal.dataId]), "Agent")),
}));
