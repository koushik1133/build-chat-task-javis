import { NextResponse } from "next/server";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { query } from "@/lib/dsql";

export const runtime = "nodejs";

const STATUSES = new Set(["queued", "running", "awaiting_approval", "done", "failed", "cancelled"]);

/** GET /api/agents/runs?status=done&agentId=… — latest 50 runs for this user. */
export async function GET(req: Request) {
  let scope;
  try { scope = await requireScope({ area: "agents", edit: false }); }
  catch (err) { return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 }); }

  const url = new URL(req.url);
  const status = url.searchParams.get("status");
  const agentId = url.searchParams.get("agentId");
  if (status && !STATUSES.has(status)) return NextResponse.json({ error: "invalid status" }, { status: 400 });

  const params: unknown[] = [scope.dataId];
  let where = "r.user_id = $1";
  if (status) {
    params.push(status);
    where += ` AND r.status = $${params.length}`;
  }
  if (agentId) {
    params.push(agentId);
    where += ` AND r.agent_id = $${params.length}`;
  }

  const runs = await query(
    `SELECT r.id, r.agent_id, r.workflow_name, r.prompt, r.output, r.status, r.trigger_kind, r.trigger_ref,
            r.error, r.tokens_in, r.tokens_out, r.cost_micros, r.started_at, r.finished_at, r.created_at,
            a.name AS agent_name, a.role AS agent_role
     FROM agent_runs r
     JOIN agents a ON a.id = r.agent_id
     WHERE ${where}
     ORDER BY r.created_at DESC
     LIMIT 50`,
    params
  ).catch(() => []);
  return NextResponse.json({ runs });
}
