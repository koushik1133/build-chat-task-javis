import { NextResponse } from "next/server";
import { z } from "zod";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { query, queryOne } from "@/lib/dsql";
import { getEval, listEvalRuns, toEvalRunDTO, type EvalRow } from "@/lib/evals/run";
import { MAX_CASES, parseCases } from "@/lib/evals/score";

export const runtime = "nodejs";

const CaseSchema = z
  .object({
    input: z.string().trim().min(1).max(8000),
    expected: z.string().max(8000).optional().nullable(),
    rubric: z.string().max(4000).optional().nullable(),
  })
  .strict();

const Patch = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    cases: z.array(CaseSchema).max(MAX_CASES).optional(),
  })
  .strict();

function toDTO(e: EvalRow) {
  return { id: e.id, agent_id: e.agent_id, name: e.name, cases: parseCases(e.cases), created_at: e.created_at, updated_at: e.updated_at };
}

/** GET /api/evals/:id → { eval, runs } (runs without per-case results). */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  let scope;
  try { scope = await requireScope({ area: "agents", edit: false }); }
  catch (err) { return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 }); }
  const { id } = await ctx.params;
  try {
    const ev = await getEval(scope.dataId, id);
    if (!ev) return NextResponse.json({ error: "not found" }, { status: 404 });
    const runs = await listEvalRuns(scope.dataId, id, 20);
    return NextResponse.json({ eval: toDTO(ev), runs: runs.map((r) => toEvalRunDTO(r, { withResults: false })) });
  } catch (err) {
    console.error("[evals] get failed:", err);
    return NextResponse.json({ error: "Could not load eval." }, { status: 500 });
  }
}

/** PATCH /api/evals/:id { name?, cases? } */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  let scope;
  try { scope = await requireScope({ area: "agents", edit: true }); }
  catch (err) { return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 }); }
  const { id } = await ctx.params;
  const parsed = Patch.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ") }, { status: 400 });
  }
  try {
    const ev = await getEval(scope.dataId, id);
    if (!ev) return NextResponse.json({ error: "not found" }, { status: 404 });
    const name = parsed.data.name ?? ev.name;
    const cases = parsed.data.cases !== undefined ? JSON.stringify(parseCases(parsed.data.cases)) : ev.cases ?? "[]";
    await query(`UPDATE agent_evals SET name = $2, cases = $3, updated_at = NOW() WHERE id = $1 AND user_id = $4`, [id, name, cases, scope.dataId]);
    const fresh = await queryOne<EvalRow>(`SELECT * FROM agent_evals WHERE id = $1 AND user_id = $2`, [id, scope.dataId]);
    return NextResponse.json({ eval: toDTO(fresh ?? ev) });
  } catch (err) {
    console.error("[evals] patch failed:", err);
    return NextResponse.json({ error: "Could not save eval." }, { status: 500 });
  }
}

/** DELETE /api/evals/:id → removes the eval and its runs. */
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  let scope;
  try { scope = await requireScope({ area: "agents", edit: true }); }
  catch (err) { return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 }); }
  const { id } = await ctx.params;
  try {
    const ev = await getEval(scope.dataId, id);
    if (!ev) return NextResponse.json({ error: "not found" }, { status: 404 });
    await query(`DELETE FROM agent_eval_runs WHERE eval_id = $1 AND user_id = $2`, [id, scope.dataId]);
    await query(`DELETE FROM agent_evals WHERE id = $1 AND user_id = $2`, [id, scope.dataId]);
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    console.error("[evals] delete failed:", err);
    return NextResponse.json({ error: "Could not delete eval." }, { status: 500 });
  }
}
