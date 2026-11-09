import { NextResponse } from "next/server";
import { z } from "zod";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { planRun } from "@/lib/automations/engine";
import { AutomationDefinitionSchema } from "@/lib/automations/schema";
import { definitionOf, getAutomation } from "@/lib/automations/store";
import { buildContext, syntheticEvent, toRunEvent, type EventRow } from "@/lib/automations/triggers";
import { queryOne } from "@/lib/dsql";
import { samplePayload } from "@/lib/webhooks/dispatch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z
  .object({
    /** Use a real stored event as the sample. */
    sampleEventId: z.string().max(100).optional(),
    /** Or an inline sample (type + data). */
    event: z.object({ type: z.string().min(1).max(120), entity: z.string().max(60).optional(), entity_id: z.string().max(100).optional(), data: z.record(z.unknown()).optional() }).strict().optional(),
    /** Unsaved editor state to test instead of the stored definition. */
    definition: z.unknown().optional(),
  })
  .strict();

/** POST: dry run — evaluate trigger + conditions and render every step, executing nothing. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  let scope;
  try {
    scope = await requireScope({ area: "agents", edit: true });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await ctx.params;
  const raw = (await req.json().catch(() => ({}))) ?? {};
  const body = Body.safeParse(raw);
  if (!body.success) return NextResponse.json({ error: "Invalid body", details: body.error.flatten() }, { status: 400 });

  let def;
  if (id === "new") {
    const parsed = AutomationDefinitionSchema.safeParse(body.data.definition);
    if (!parsed.success) return NextResponse.json({ error: "Invalid definition", details: parsed.error.flatten() }, { status: 400 });
    def = parsed.data;
  } else {
    const row = await getAutomation(scope.dataId, id).catch(() => null);
    if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });
    if (body.data.definition !== undefined) {
      const parsed = AutomationDefinitionSchema.safeParse(body.data.definition);
      if (!parsed.success) return NextResponse.json({ error: "Invalid definition", details: parsed.error.flatten() }, { status: 400 });
      def = parsed.data;
    } else {
      def = definitionOf(row);
    }
  }

  let event = null;
  if (body.data.sampleEventId) {
    const e = await queryOne<EventRow>(`SELECT id, user_id, type, entity, entity_id, data, created_at FROM events WHERE id = $1 AND user_id = $2`, [body.data.sampleEventId, scope.dataId]).catch(() => null);
    if (!e) return NextResponse.json({ error: "sample event not found" }, { status: 404 });
    event = toRunEvent(e);
  } else if (body.data.event) {
    const sample = samplePayload(body.data.event.type);
    event = syntheticEvent(body.data.event.type, body.data.event.data ?? sample.data, body.data.event.entity ?? sample.entity, body.data.event.entity_id ?? "sample_id");
  } else {
    const type = def.trigger_type === "event" ? (def.trigger_config.event_type ?? "webhook.test").replace(/\.\*$/, ".created").replace(/\*/g, "test") : `automation.${def.trigger_type}`;
    const sample = samplePayload(type);
    event = syntheticEvent(type, sample.data, sample.entity, "sample_id");
  }

  const context = await buildContext(scope.dataId, { id, name: def.name }, event);
  const plan = planRun(def, id, context);
  return NextResponse.json({ plan });
}
