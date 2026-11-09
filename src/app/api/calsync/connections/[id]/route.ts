import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { recordAudit } from "@/lib/audit";
import { getConnection, updateConnection } from "@/lib/calsync/connections";
import { syncConnection } from "@/lib/calsync/sync";
import { rateLimitAsync } from "@/lib/request-limits";
import { isResponse, syncScope } from "../../_shared";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const Patch = z
  .object({
    settings: z.object({ push_bookings: z.boolean().optional(), pull_busy: z.boolean().optional(), calendar_id: z.string().min(1).max(300).nullable().optional() }).strict().optional(),
    status: z.enum(["connected", "disabled"]).optional(),
  })
  .strict();

/** PATCH: change sync settings / enable / disable. */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const scope = await syncScope(true);
  if (isResponse(scope)) return scope;
  const { id } = await ctx.params;
  const parsed = Patch.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request", details: parsed.error.flatten() }, { status: 400 });
  const settings = parsed.data.settings ? Object.fromEntries(Object.entries(parsed.data.settings).filter(([, v]) => v !== undefined)) : undefined;
  const row = await updateConnection(scope.dataId, id, { settings, status: parsed.data.status });
  if (!row) return NextResponse.json({ error: "Connection not found" }, { status: 404 });
  await recordAudit(scope, { action: "calsync.update", entity: "calendar_connection", entityId: id });
  return NextResponse.json({ ok: true });
}

/** POST: sync now (push missing bookings, pull busy time). */
export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const scope = await syncScope(true);
  if (isResponse(scope)) return scope;
  const { id } = await ctx.params;
  const rl = await rateLimitAsync(`calsync:sync:${scope.dataId}`, 12, 60_000);
  if (!rl.allowed) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  const row = await getConnection(scope.dataId, id);
  if (!row) return NextResponse.json({ error: "Connection not found" }, { status: 404 });
  try {
    const result = await syncConnection(id);
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message.slice(0, 300) : "Sync failed" }, { status: 502 });
  }
}
