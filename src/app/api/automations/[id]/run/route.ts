import { NextResponse } from "next/server";
import { z } from "zod";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { rateLimitAsync } from "@/lib/request-limits";
import { runQueued } from "@/lib/automations/engine";
import { getAutomation, getRun, toRunDTO } from "@/lib/automations/store";
import { enqueueManualRun, syntheticEvent } from "@/lib/automations/triggers";
import { samplePayload } from "@/lib/webhooks/dispatch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z
  .object({
    sampleEventId: z.string().max(100).optional(),
    event: z.object({ type: z.string().min(1).max(120), data: z.record(z.unknown()).optional() }).strict().optional(),
  })
  .strict();

/** POST: queue a manual run and execute it right away (steps really run). */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  let scope;
  try {
    scope = await requireScope({ area: "agents", edit: true });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const rl = await rateLimitAsync(`automations:run:${scope.dataId}`, 30, 60_000);
  if (!rl.allowed) return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  const { id } = await ctx.params;
  const body = Body.safeParse((await req.json().catch(() => ({}))) ?? {});
  if (!body.success) return NextResponse.json({ error: "Invalid body", details: body.error.flatten() }, { status: 400 });
  const row = await getAutomation(scope.dataId, id).catch(() => null);
  if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });
  const inline = body.data.event ? syntheticEvent(body.data.event.type, body.data.event.data ?? samplePayload(body.data.event.type).data, samplePayload(body.data.event.type).entity, "sample_id") : null;
  try {
    const { runId } = await enqueueManualRun(scope.dataId, row, { eventId: body.data.sampleEventId ?? null, event: inline });
    await runQueued(20);
    const run = await getRun(scope.dataId, runId);
    return NextResponse.json({ run: run ? toRunDTO(run) : null, runId }, { status: 201 });
  } catch (err) {
    console.error("[automations] manual run failed:", err);
    return NextResponse.json({ error: "Run failed to start" }, { status: 503 });
  }
}
