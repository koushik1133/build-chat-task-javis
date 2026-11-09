import { NextResponse } from "next/server";
import { z } from "zod";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { query } from "@/lib/dsql";
import { APPROVAL_COLUMNS, ApprovalError, decideApproval, type ApprovalRow } from "@/lib/approvals/decide";

/**
 * Decide an approval. `edited_input` lets the operator change the proposed
 * payload before approving (validated against the tool schema; recorded as a
 * correction). The logic lives in src/lib/approvals/decide.ts and is shared
 * with `POST /api/v1/approvals/{id}/decide`.
 */
const Body = z.object({
  decision: z.enum(["approved", "rejected"]),
  edited_input: z.record(z.string(), z.unknown()).optional(),
});

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  let scope;
  try { scope = await requireScope({ area: "agents", edit: true }); }
  catch (err) { return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 }); }

  const { id } = await ctx.params;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "decision must be approved or rejected" }, { status: 400 });

  try {
    const { approval, outcome } = await decideApproval(scope.dataId, id, parsed.data, scope.dataId);
    return NextResponse.json({ approval, outcome });
  } catch (err) {
    if (err instanceof ApprovalError) return NextResponse.json({ error: err.message }, { status: err.status });
    console.error("[approvals] decide failed", err);
    return NextResponse.json({ error: "Could not record the decision" }, { status: 500 });
  }
}

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  let scope;
  try { scope = await requireScope({ area: "agents", edit: false }); }
  catch (err) { return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 }); }
  const { id } = await ctx.params;
  const rows = await query<ApprovalRow>(
    `SELECT ${APPROVAL_COLUMNS} FROM approvals WHERE id = $1 AND user_id = $2`, [id, scope.dataId]
  ).catch(() => []);
  if (rows.length === 0) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ approval: rows[0] });
}
