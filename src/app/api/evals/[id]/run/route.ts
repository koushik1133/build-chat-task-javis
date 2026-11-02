import { NextResponse } from "next/server";
import { z } from "zod";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { executeEvalRun, startEvalRun, toEvalRunDTO } from "@/lib/evals/run";
import { llmErrorResponse } from "@/lib/llm-response";

export const runtime = "nodejs";
export const maxDuration = 60;

const Body = z.object({ inline: z.boolean().optional() }).strict();

/**
 * POST /api/evals/:id/run            → 202 { run } (the cron worker executes the "eval" job)
 * POST /api/evals/:id/run { inline } → runs now and returns the finished run
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  let scope;
  try { scope = await requireScope({ area: "agents", edit: true }); }
  catch (err) { return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 }); }
  const { id } = await ctx.params;

  const raw = await req.text().catch(() => "");
  let inline = false;
  if (raw.trim()) {
    let json: unknown;
    try { json = JSON.parse(raw); } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }
    const parsed = Body.safeParse(json);
    if (!parsed.success) return NextResponse.json({ error: "Invalid body" }, { status: 400 });
    inline = parsed.data.inline === true;
  }

  let run;
  try {
    run = await startEvalRun(scope.dataId, id, { enqueue: !inline });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Could not start eval run.";
    if (/not found/i.test(msg)) return NextResponse.json({ error: msg }, { status: 404 });
    if (/at least one case/i.test(msg)) return NextResponse.json({ error: msg }, { status: 400 });
    console.error("[evals/run] start failed:", err);
    return NextResponse.json({ error: "Could not start eval run." }, { status: 500 });
  }
  if (!inline) return NextResponse.json({ run: toEvalRunDTO(run) }, { status: 202, headers: { Location: `/api/evals/runs/${run.id}` } });

  try {
    const finished = await executeEvalRun(run.id);
    return NextResponse.json({ run: toEvalRunDTO(finished ?? run) });
  } catch (err) {
    const mapped = llmErrorResponse(err);
    if (mapped) return mapped;
    console.error("[evals/run] inline execution failed:", err);
    return NextResponse.json({ error: "Eval run failed." }, { status: 500 });
  }
}
