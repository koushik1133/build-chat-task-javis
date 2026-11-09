import { queryOne } from "@/lib/dsql";
import { enqueueJob } from "@/lib/agents/queue";
import { getTool } from "@/lib/agents/registry";
import { rememberCorrection } from "@/lib/agents/memory";
import { keyMayUseTool, scopeForTool } from "@/lib/agents/tool-scopes";
import type { ToolContext } from "@/lib/agents/types";

/**
 * Approval decisions, shared by the in-app route (`/api/approvals/[id]`) and
 * the public API (`POST /api/v1/approvals/{id}/decide`).
 *
 * - An approval tied to an agent run resumes that run through the job queue.
 * - A copilot/MCP approval has no run: on approval the tool executes inline
 *   and the outcome is appended to the preview.
 * - `edited_input` lets the operator change the proposed payload before
 *   approving; it is validated against the tool schema and recorded as a
 *   correction so the agent learns from it.
 */

export type ApprovalRow = {
  id: string;
  run_id: string | null;
  agent_id: string | null;
  tool_name: string;
  input: string | null;
  preview: string | null;
  status: string;
  decided_by: string | null;
  decided_at: string | null;
  expires_at: string | null;
  created_at: string;
};

export const APPROVAL_COLUMNS = `id, run_id, agent_id, tool_name, input, preview, status, decided_by, decided_at, expires_at, created_at`;

export class ApprovalError extends Error {
  constructor(
    message: string,
    public readonly status: 400 | 403 | 404 | 409
  ) {
    super(message);
    this.name = "ApprovalError";
  }
}

export interface DecideInput {
  decision: "approved" | "rejected";
  edited_input?: Record<string, unknown>;
}

export interface DecideOptions {
  /**
   * API-key scopes of the caller. When set, approving is refused (403) unless
   * the key could call the approval's tool itself — `write:agents` alone must
   * not become a way to execute billing/crm/… writes queued by another key.
   * Omit for in-app operators, whose role check happens at the route.
   */
  allowedScopes?: readonly string[];
}

/** Throws ApprovalError 403 when `scopes` cannot execute `toolName`. Unknown tools are left to the executor. */
export function assertScopesMayExecute(toolName: string, scopes: readonly string[] | undefined): void {
  if (!scopes) return;
  const spec = getTool(toolName);
  if (!spec) return;
  if (!keyMayUseTool(scopes, spec)) {
    throw new ApprovalError(`This API key lacks the "${scopeForTool(spec)}" scope needed to approve ${toolName}`, 403);
  }
}

export interface DecideResult {
  approval: ApprovalRow & { agent_name: string | null };
  /** Set when a copilot/MCP approval was executed inline. */
  outcome: string | null;
}

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

/** Copilot/MCP approvals have no run to resume: execute the tool here. */
async function executeDirectly(userId: string, row: ApprovalRow): Promise<string> {
  const { ensureToolsLoaded } = await import("@/lib/agents/tools/index");
  ensureToolsLoaded();
  const spec = getTool(row.tool_name);
  if (!spec) return `Tool ${row.tool_name} is not registered`;

  let input: unknown = {};
  try {
    input = JSON.parse(row.input ?? "{}");
  } catch {
    /* keep {} */
  }
  const parsed = spec.input.safeParse(input);
  if (!parsed.success) return `Invalid input: ${parsed.error.issues.map((i) => i.message).join("; ").slice(0, 300)}`;

  const ctx: ToolContext = { userId, runId: row.run_id ?? "copilot", agentId: null, autonomy: "auto" };
  try {
    const result = await spec.run(ctx, parsed.data);
    return result.ok ? `Done: ${result.summary}` : `Failed: ${result.error ?? result.summary}`;
  } catch (err) {
    return `Failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export async function getApproval(dataId: string, id: string): Promise<ApprovalRow | null> {
  return queryOne<ApprovalRow>(`SELECT ${APPROVAL_COLUMNS} FROM approvals WHERE id = $1 AND user_id = $2`, [id, dataId]).catch(() => null);
}

/** Decide a pending approval. Throws `ApprovalError` (400/404/409). */
export async function decideApproval(dataId: string, id: string, input: DecideInput, actorId: string = dataId, opts: DecideOptions = {}): Promise<DecideResult> {
  const { decision, edited_input } = input;

  let editedJson: string | null = null;
  let original: ApprovalRow | null = null;
  if (decision === "approved" && (edited_input || opts.allowedScopes)) {
    original = await getApproval(dataId, id);
    if (!original) throw new ApprovalError("not found", 404);
    if (original.status !== "pending") throw new ApprovalError(`already ${original.status}`, 409);
    const { ensureToolsLoaded } = await import("@/lib/agents/tools/index");
    ensureToolsLoaded();
    assertScopesMayExecute(original.tool_name, opts.allowedScopes);
  }
  if (edited_input && decision === "approved" && original) {
    const v = validateEditedInput(original.tool_name, edited_input);
    if (!v.ok) throw new ApprovalError(v.error, 400);
    editedJson = JSON.stringify(v.input);
    if (editedJson === (original.input ?? "")) editedJson = null;
  }

  const row = await queryOne<ApprovalRow>(
    `UPDATE approvals SET status = $1, decided_by = $2, decided_at = NOW(), input = COALESCE($4, input)
     WHERE id = $3 AND user_id = $5 AND status = 'pending'
     RETURNING ${APPROVAL_COLUMNS}`,
    [decision, actorId, id, editedJson, dataId]
  ).catch(() => null);

  if (row && editedJson && original?.agent_id) {
    void rememberCorrection(dataId, {
      agentId: original.agent_id,
      runId: row.run_id,
      stepId: await approvalStepId(dataId, row.run_id, row.tool_name),
      original: `${row.tool_name} ${original.input ?? "{}"}`,
      corrected: `${row.tool_name} ${editedJson}`,
      note: `Operator edited the ${row.tool_name} payload before approving`,
    }).catch((err) => console.error("[approvals] failed to record correction", err));
  }
  if (!row) {
    const exists = await queryOne<{ status: string }>(`SELECT status FROM approvals WHERE id = $1 AND user_id = $2`, [id, dataId]).catch(() => null);
    if (!exists) throw new ApprovalError("not found", 404);
    throw new ApprovalError(`already ${exists.status}`, 409);
  }

  let updated: ApprovalRow = row;
  let outcome: string | null = null;
  if (row.run_id && row.run_id !== "mcp") {
    await enqueueJob(dataId, { kind: "resume", runId: row.run_id, approvalId: row.id }).catch((err) => console.error("[approvals] failed to enqueue resume", err));
  } else if (decision === "approved") {
    outcome = await executeDirectly(dataId, row);
    const preview = `${row.preview ?? row.tool_name} — ${outcome}`.slice(0, 1000);
    updated =
      (await queryOne<ApprovalRow>(`UPDATE approvals SET preview = $1 WHERE id = $2 AND user_id = $3 RETURNING ${APPROVAL_COLUMNS}`, [preview, row.id, dataId]).catch(
        () => null
      )) ?? { ...row, preview };
  }

  const agent = updated.agent_id
    ? await queryOne<{ name: string }>(`SELECT name FROM agents WHERE id::text = $1 AND user_id = $2`, [updated.agent_id, dataId]).catch(() => null)
    : null;
  return { approval: { ...updated, agent_name: agent?.name ?? null }, outcome };
}
