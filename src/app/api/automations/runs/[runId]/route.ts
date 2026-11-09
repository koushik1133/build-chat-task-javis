import { NextResponse } from "next/server";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { runQueued } from "@/lib/automations/engine";
import { getRun, requeueRun, toRunDTO } from "@/lib/automations/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ runId: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  let scope;
  try {
    scope = await requireScope({ area: "agents", edit: false });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { runId } = await ctx.params;
  const run = await getRun(scope.dataId, runId).catch(() => null);
  if (!run) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ run: toRunDTO(run) });
}

/** POST: retry a finished run from the first step (same context). */
export async function POST(_req: Request, ctx: Ctx) {
  let scope;
  try {
    scope = await requireScope({ area: "agents", edit: true });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { runId } = await ctx.params;
  const existing = await getRun(scope.dataId, runId).catch(() => null);
  if (!existing) return NextResponse.json({ error: "not found" }, { status: 404 });
  const requeued = await requeueRun(scope.dataId, runId).catch(() => null);
  if (!requeued) return NextResponse.json({ error: `run is ${existing.status}; only finished runs can be retried` }, { status: 409 });
  await runQueued(20).catch((err) => console.error("[automations] retry tick failed:", err));
  const run = await getRun(scope.dataId, runId).catch(() => null);
  return NextResponse.json({ run: run ? toRunDTO(run) : toRunDTO(requeued) });
}
