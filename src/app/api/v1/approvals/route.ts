import { query } from "@/lib/dsql";
import { ROUTES } from "@/lib/public-api/registry";
import { op } from "@/lib/public-api/handler";
import { keysetClause, keysetOrder, page } from "@/lib/public-api/pagination";
import { approvalView, type ApprovalWithAgent } from "@/lib/public-api/views";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = op(ROUTES.listApprovals, async ({ principal, query: q, list }) => {
  const params: unknown[] = [principal.dataId];
  let where = `a.user_id = $1`;
  if (q.status) { params.push(q.status); where += ` AND a.status = $${params.length}`; }
  where += keysetClause(list.cursor, params, { alias: "a." });
  params.push(list.limit + 1);
  const rows = await query<ApprovalWithAgent>(
    `SELECT a.id, a.run_id, a.agent_id, a.tool_name, a.input, a.preview, a.status, a.decided_by, a.decided_at, a.expires_at, a.created_at, ag.name AS agent_name
     FROM approvals a LEFT JOIN agents ag ON ag.id::text = a.agent_id::text WHERE ${where} ORDER BY ${keysetOrder("a.")} LIMIT $${params.length}`,
    params
  );
  const p = page(rows, list.limit, (r) => ({ created_at: r.created_at, id: r.id }));
  return { data: p.data.map(approvalView), meta: { next_cursor: p.next_cursor } };
});
