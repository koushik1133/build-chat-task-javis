import { query } from "@/lib/dsql";
import { ROUTES } from "@/lib/public-api/registry";
import { op } from "@/lib/public-api/handler";
import { keysetClause, keysetOrder, normaliseCursor, page } from "@/lib/public-api/pagination";
import { runView, RUN_SELECT, type RunRow } from "@/lib/public-api/views";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = op(ROUTES.listAgentRuns, async ({ principal, query: q, list }) => {
  const params: unknown[] = [principal.dataId];
  let where = `r.user_id = $1`;
  if (q.agent_id) { params.push(q.agent_id); where += ` AND r.agent_id::text = $${params.length}`; }
  if (q.status) { params.push(q.status); where += ` AND r.status = $${params.length}`; }
  where += keysetClause(list.cursor, params, { alias: "r." });
  params.push(list.limit + 1);
  const rows = await query<RunRow>(`${RUN_SELECT} WHERE ${where} ORDER BY ${keysetOrder("r.")} LIMIT $${params.length}`, params);
  const p = page(rows, list.limit, (r) => normaliseCursor({ created_at: r.created_at, id: r.id }));
  return { data: p.data.map(runView), meta: { next_cursor: p.next_cursor } };
});
