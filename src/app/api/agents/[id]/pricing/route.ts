import { NextResponse } from "next/server";
import { z } from "zod";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { query, queryOne } from "@/lib/dsql";
import { EVENT_TYPES } from "@/lib/events/bus";

export const runtime = "nodejs";

/**
 * Outcome pricing for one agent: which events-bus event counts as the
 * outcome and how many credits it is worth. Charged once per run that ends
 * with the event having fired (see src/lib/credits/outcomes.ts).
 */

type Row = { outcome_event: string | null; outcome_price_credits: string | number | null };

const Patch = z
  .object({
    outcome_event: z.string().trim().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/, "event types look like entity.action").max(100).nullable(),
    outcome_price_credits: z.number().int().min(0).max(10_000_000).nullable(),
  })
  .strict();

async function load(userId: string, id: string): Promise<Row | null> {
  return queryOne<Row>(`SELECT outcome_event, outcome_price_credits FROM agents WHERE id::text = $1 AND user_id = $2`, [id, userId]);
}

function view(row: Row) {
  return {
    outcome_event: row.outcome_event ?? null,
    outcome_price_credits: row.outcome_price_credits == null ? null : Number(row.outcome_price_credits),
    event_types: EVENT_TYPES,
  };
}

/** GET /api/agents/:id/pricing */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  let scope;
  try { scope = await requireScope({ area: "agents", edit: false }); }
  catch (err) { return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 }); }
  const { id } = await ctx.params;
  try {
    const row = await load(scope.dataId, id);
    if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json({ pricing: view(row) });
  } catch (err) {
    console.error("[agents/pricing] get failed:", err);
    return NextResponse.json({ error: "Could not load outcome pricing (run the Phase 4 migration)." }, { status: 500 });
  }
}

/** PATCH /api/agents/:id/pricing { outcome_event, outcome_price_credits } */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  let scope;
  try { scope = await requireScope({ area: "agents", edit: true }); }
  catch (err) { return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 }); }
  const { id } = await ctx.params;
  const parsed = Patch.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ") }, { status: 400 });
  }
  const { outcome_event, outcome_price_credits } = parsed.data;
  try {
    const existing = await load(scope.dataId, id);
    if (!existing) return NextResponse.json({ error: "not found" }, { status: 404 });
    await query(`UPDATE agents SET outcome_event = $3, outcome_price_credits = $4 WHERE id::text = $1 AND user_id = $2`, [
      id,
      scope.dataId,
      outcome_event || null,
      outcome_event ? outcome_price_credits : null,
    ]);
    const row = await load(scope.dataId, id);
    return NextResponse.json({ pricing: view(row ?? existing) });
  } catch (err) {
    console.error("[agents/pricing] patch failed:", err);
    return NextResponse.json({ error: "Could not save outcome pricing." }, { status: 500 });
  }
}
