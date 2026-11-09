import { queryOne } from "@/lib/dsql";
import { ROUTES } from "@/lib/public-api/registry";
import { op, mustFind } from "@/lib/public-api/handler";
import { runView, RUN_SELECT, type RunRow } from "@/lib/public-api/views";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = op(ROUTES.getAgentRun, async ({ principal, params }) => ({
  data: runView(mustFind(await queryOne<RunRow>(`${RUN_SELECT} WHERE r.id = $1 AND r.user_id = $2`, [params.id, principal.dataId]), "Run")),
}));
