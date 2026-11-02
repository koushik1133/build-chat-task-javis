import { NextResponse } from "next/server";
import { z } from "zod";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { query, queryOne } from "@/lib/dsql";
import { enqueueJob } from "@/lib/agents/queue";
import { getTool } from "@/lib/agents/registry";
import { rememberCorrection } from "@/lib/agents/memory";
import type { ToolContext } from "@/lib/agents/types";

/**
 * `edited_input` lets the operator change the proposed payload before
 * approving. The edit is validated against the tool's schema, stored on the
 * approval (which the runner treats as authoritative on resume) and recorded
 * as a correction so the agent learns from it.
 */
const Body = z.object({
  decision: z.enum(["approved", "rejected"]),
  edited_input: z.record(z.string(), z.unknown()).optional(),
});

/** Validate an operator edit against the tool's input schema. Returns the normalised input or an error string. */
function validateEditedInput(toolName: string, edited: Record<string, unknown>): { ok: true; input: unknown } | { ok: false; error: string } {
  const spec = getTool(toolName);
  if (!spec) return { ok: false, error: `Tool ${toolName} is not registered` };
  const parsed = spec.input.safeParse(edited);
  if (!parsed.success) {
    return { ok: false, error: `Edited input is invalid: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`.slice(0, 500) };
  }
  return { ok: true, input: parsed.data };
}

async function approvalStepId(userId: string, runId: string | null, toolName: string): Promise<string | null> {
  if (!runId) return null;
  const row = await queryOne<{ id: string }>(
    `SELECT id FROM agent_run_steps WHERE run_id = $1 AND user_id = $2 AND kind = 'approval' AND name = $3 ORDER BY idx DESC LIMIT 1`,
    [runId, userId, toolName]
  ).catch(() => null);
  return row?.id ?? null;
}

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
  let scope;
  try { scope = await requireScope({ area: "agents", edit: true }); }
  catch (err) { return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 }); }

  const { id } = await ctx.params;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "decision must be approved or rejected" }, { status: 400 });
  const { decision, edited_input } = parsed.data;

  // Operator edited the proposed payload: validate it and swap it in with the decision.
  let editedJson: string | null = null;
  let original: ApprovalRow | null = null;
  if (edited_input && decision === "approved") {
    original = await queryOne<ApprovalRow>(`SELECT ${COLUMNS} FROM approvals WHERE id = $1 AND user_id = $2`, [id, scope.dataId]).catch(() => null);
    if (!original) return NextResponse.json({ error: "not found" }, { status: 404 });
    if (original.status !== "pending") return NextResponse.json({ error: `already ${original.status}` }, { status: 409 });
    const { ensureToolsLoaded } = await import("@/lib/agents/tools/index");
    ensureToolsLoaded();
    const v = validateEditedInput(original.tool_name, edited_input);
    if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 });
    editedJson = JSON.stringify(v.input);
    if (editedJson === (original.input ?? "")) editedJson = null; // nothing actually changed
  }

  const row = await queryOne<ApprovalRow>(
    `UPDATE approvals SET status = $1, decided_by = $2, decided_at = NOW(), input = COALESCE($4, input)
     WHERE id = $3 AND user_id = $2 AND status = 'pending'
     RETURNING ${COLUMNS}`,
    [decision, scope.dataId, id, editedJson]
  ).catch(() => null);
  if (row && editedJson && original?.agent_id) {
    // Corrections-as-memory: what the agent proposed vs. what the operator actually wanted.
    void rememberCorrection(scope.dataId, {
      agentId: original.agent_id,
      runId: row.run_id,
      stepId: await approvalStepId(scope.dataId, row.run_id, row.tool_name),
      original: `${row.tool_name} ${original.input ?? "{}"}`,
      corrected: `${row.tool_name} ${editedJson}`,
      note: `Operator edited the ${row.tool_name} payload before approving`,
    }).catch((err) => console.error("[approvals] failed to record correction", err));
  }
  if (!row) {
    const exists = await queryOne<{ status: string }>(
      `SELECT status FROM approvals WHERE id = $1 AND user_id = $2`, [id, scope.dataId]
    ).catch(() => null);
    if (!exists) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json({ error: `already ${exists.status}` }, { status: 409 });
  }

  let updated: ApprovalRow = row;
  if (row.run_id) {
    await enqueueJob(scope.dataId, { kind: "resume", runId: row.run_id, approvalId: row.id }).catch((err) =>
      console.error("[approvals] failed to enqueue resume", err)
    );
  } else if (decision === "approved") {
    const outcome = await executeDirectly(scope.dataId, row);
    const preview = `${row.preview ?? row.tool_name} — ${outcome}`.slice(0, 1000);
    updated = (await queryOne<ApprovalRow>(
      `UPDATE approvals SET preview = $1 WHERE id = $2 AND user_id = $3 RETURNING ${COLUMNS}`,
      [preview, row.id, scope.dataId]
    ).catch(() => null)) ?? { ...row, preview };
  }

  const agent = updated.agent_id
    ? await queryOne<{ name: string }>(`SELECT name FROM agents WHERE id::text = $1 AND user_id = $2`, [updated.agent_id, scope.dataId]).catch(() => null)
    : null;
  return NextResponse.json({ approval: { ...updated, agent_name: agent?.name ?? null } });
}

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  let scope;
  try { scope = await requireScope({ area: "agents", edit: false }); }
  catch (err) { return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 }); }
  const { id } = await ctx.params;
  const rows = await query<ApprovalRow>(
    `SELECT ${COLUMNS} FROM approvals WHERE id = $1 AND user_id = $2`, [id, scope.dataId]
  ).catch(() => []);
  if (rows.length === 0) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ approval: rows[0] });
}
