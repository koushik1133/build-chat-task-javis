import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/supabase/server";
import { query, queryOne } from "@/lib/dsql";
import { enqueueJob } from "@/lib/agents/queue";
import { getTool } from "@/lib/agents/registry";
import type { ToolContext } from "@/lib/agents/types";

const Body = z.object({ decision: z.enum(["approved", "rejected"]) });

type ApprovalRow = {
  id: string; run_id: string | null; agent_id: string | null; tool_name: string;
  input: string | null; preview: string | null; status: string;
  decided_by: string | null; decided_at: string | null; expires_at: string | null; created_at: string;
};

const COLUMNS = `id, run_id, agent_id, tool_name, input, preview, status, decided_by, decided_at, expires_at, created_at`;

/** Copilot-originated approvals have no run to resume: execute the tool here. */
async function executeDirectly(userId: string, row: ApprovalRow): Promise<string> {
  const { ensureToolsLoaded } = await import("@/lib/agents/tools/index");
  ensureToolsLoaded();
  const spec = getTool(row.tool_name);
  if (!spec) return `Tool ${row.tool_name} is not registered`;

  let input: unknown = {};
  try { input = JSON.parse(row.input ?? "{}"); } catch { /* keep {} */ }
  const parsed = spec.input.safeParse(input);
  if (!parsed.success) return `Invalid input: ${parsed.error.issues.map((i) => i.message).join("; ").slice(0, 300)}`;

  const ctx: ToolContext = { userId, runId: "copilot", agentId: null, autonomy: "auto" };
  try {
    const result = await spec.run(ctx, parsed.data);
    return result.ok ? `Done: ${result.summary}` : `Failed: ${result.error ?? result.summary}`;
  } catch (err) {
    return `Failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  let user;
  try { ({ user } = await requireUser()); }
  catch { return NextResponse.json({ error: "unauthorized" }, { status: 401 }); }

  const { id } = await ctx.params;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "decision must be approved or rejected" }, { status: 400 });
  const { decision } = parsed.data;

  const row = await queryOne<ApprovalRow>(
    `UPDATE approvals SET status = $1, decided_by = $2, decided_at = NOW()
     WHERE id = $3 AND user_id = $2 AND status = 'pending'
     RETURNING ${COLUMNS}`,
    [decision, user.id, id]
  ).catch(() => null);
  if (!row) {
    const exists = await queryOne<{ status: string }>(
      `SELECT status FROM approvals WHERE id = $1 AND user_id = $2`, [id, user.id]
    ).catch(() => null);
    if (!exists) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json({ error: `already ${exists.status}` }, { status: 409 });
  }

  let updated: ApprovalRow = row;
  if (row.run_id) {
    await enqueueJob(user.id, { kind: "resume", runId: row.run_id, approvalId: row.id }).catch((err) =>
      console.error("[approvals] failed to enqueue resume", err)
    );
  } else if (decision === "approved") {
    const outcome = await executeDirectly(user.id, row);
    const preview = `${row.preview ?? row.tool_name} — ${outcome}`.slice(0, 1000);
    updated = (await queryOne<ApprovalRow>(
      `UPDATE approvals SET preview = $1 WHERE id = $2 AND user_id = $3 RETURNING ${COLUMNS}`,
      [preview, row.id, user.id]
    ).catch(() => null)) ?? { ...row, preview };
  }

  const agent = updated.agent_id
    ? await queryOne<{ name: string }>(`SELECT name FROM agents WHERE id::text = $1 AND user_id = $2`, [updated.agent_id, user.id]).catch(() => null)
    : null;
  return NextResponse.json({ approval: { ...updated, agent_name: agent?.name ?? null } });
}

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  let user;
  try { ({ user } = await requireUser()); }
  catch { return NextResponse.json({ error: "unauthorized" }, { status: 401 }); }
  const { id } = await ctx.params;
  const rows = await query<ApprovalRow>(
    `SELECT ${COLUMNS} FROM approvals WHERE id = $1 AND user_id = $2`, [id, user.id]
  ).catch(() => []);
  if (rows.length === 0) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ approval: rows[0] });
}
