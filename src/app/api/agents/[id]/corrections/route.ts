import { NextResponse } from "next/server";
import { z } from "zod";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { queryOne } from "@/lib/dsql";
import { forgetCorrection, listCorrections, rememberCorrection } from "@/lib/agents/memory";

export const runtime = "nodejs";

const Create = z
  .object({
    original: z.string().trim().min(1).max(4000),
    corrected: z.string().trim().min(1).max(4000),
    note: z.string().max(1000).optional().nullable(),
    run_id: z.string().max(100).optional().nullable(),
    step_id: z.string().max(100).optional().nullable(),
  })
  .strict();

async function agentExists(userId: string, agentId: string): Promise<boolean> {
  const row = await queryOne<{ id: string }>(`SELECT id FROM agents WHERE id::text = $1 AND user_id = $2`, [agentId, userId]).catch(() => null);
  return Boolean(row);
}

/** GET /api/agents/:id/corrections → { corrections } newest first. */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  let scope;
  try { scope = await requireScope({ area: "agents", edit: false }); }
  catch (err) { return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 }); }
  const { id } = await ctx.params;
  if (!(await agentExists(scope.dataId, id))) return NextResponse.json({ error: "not found" }, { status: 404 });
  const limit = Number(new URL(req.url).searchParams.get("limit") ?? 50) || 50;
  try {
    return NextResponse.json({ corrections: await listCorrections(scope.dataId, id, limit) });
  } catch (err) {
    console.error("[agents/corrections] list failed:", err);
    return NextResponse.json({ error: "Could not load corrections." }, { status: 500 });
  }
}

/** POST /api/agents/:id/corrections { original, corrected, note? } → 201 { correction } */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  let scope;
  try { scope = await requireScope({ area: "agents", edit: true }); }
  catch (err) { return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 }); }
  const { id } = await ctx.params;
  const parsed = Create.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ") }, { status: 400 });
  }
  if (!(await agentExists(scope.dataId, id))) return NextResponse.json({ error: "not found" }, { status: 404 });
  try {
    const correction = await rememberCorrection(scope.dataId, {
      agentId: id,
      original: parsed.data.original,
      corrected: parsed.data.corrected,
      note: parsed.data.note ?? null,
      runId: parsed.data.run_id ?? null,
      stepId: parsed.data.step_id ?? null,
    });
    return NextResponse.json({ correction }, { status: 201 });
  } catch (err) {
    console.error("[agents/corrections] create failed:", err);
    return NextResponse.json({ error: "Could not save correction." }, { status: 500 });
  }
}

/** DELETE /api/agents/:id/corrections?id=<correctionId> → 204 */
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  let scope;
  try { scope = await requireScope({ area: "agents", edit: true }); }
  catch (err) { return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 }); }
  const { id } = await ctx.params;
  const correctionId = new URL(req.url).searchParams.get("id")?.trim() ?? "";
  if (!correctionId || correctionId.length > 100) return NextResponse.json({ error: "id is required" }, { status: 400 });
  try {
    const ok = await forgetCorrection(scope.dataId, id, correctionId);
    if (!ok) return NextResponse.json({ error: "not found" }, { status: 404 });
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    console.error("[agents/corrections] delete failed:", err);
    return NextResponse.json({ error: "Could not delete correction." }, { status: 500 });
  }
}
