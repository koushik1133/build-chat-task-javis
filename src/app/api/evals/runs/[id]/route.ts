import { NextResponse } from "next/server";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { getEvalRun, toEvalRunDTO } from "@/lib/evals/run";

export const runtime = "nodejs";

/** GET /api/evals/runs/:id → the run with per-case scores and transcripts. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  let scope;
  try { scope = await requireScope({ area: "agents", edit: false }); }
  catch (err) { return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 }); }
  const { id } = await ctx.params;
  try {
    const run = await getEvalRun(scope.dataId, id);
    if (!run) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json({ run: toEvalRunDTO(run) });
  } catch (err) {
    console.error("[evals/runs] get failed:", err);
    return NextResponse.json({ error: "Could not load eval run." }, { status: 500 });
  }
}
