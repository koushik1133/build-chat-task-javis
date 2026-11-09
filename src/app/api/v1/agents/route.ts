import { query } from "@/lib/dsql";
import { ROUTES } from "@/lib/public-api/registry";
import { op, singlePage } from "@/lib/public-api/handler";
import { agentView, AGENT_COLS, type AgentRow } from "@/lib/public-api/views";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = op(ROUTES.listAgents, async ({ principal, list }) =>
  singlePage((await query<AgentRow>(`SELECT ${AGENT_COLS} FROM agents WHERE user_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT $2`, [principal.dataId, list.limit])).map(agentView))
);
