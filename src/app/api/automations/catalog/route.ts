import { NextResponse } from "next/server";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { listTools } from "@/lib/agents/registry";
import { ensureToolsLoaded } from "@/lib/agents/tools/index";
import { toolInputSchema } from "@/lib/agents/tool-scopes";
import { CONDITION_OP_LABELS, CONDITION_OPS, STEP_KIND_LABELS, STEP_KINDS } from "@/lib/automations/types";
import { EVENT_TYPES } from "@/lib/events/bus";
import { query } from "@/lib/dsql";
import { samplePayload } from "@/lib/webhooks/dispatch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET: everything the builder needs — event types with sample payloads, the tool catalogue with JSON schemas, condition ops, step kinds, agents. */
export async function GET() {
  let scope;
  try {
    scope = await requireScope({ area: "agents", edit: false });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  ensureToolsLoaded();
  const [agents, recent] = await Promise.all([
    query<{ id: string; name: string; role: string }>(`SELECT id::text AS id, name, role FROM agents WHERE user_id = $1 AND deleted_at IS NULL ORDER BY name ASC LIMIT 100`, [scope.dataId]).catch(() => []),
    query<{ type: string; n: string | number }>(`SELECT type, COUNT(*) AS n FROM events WHERE user_id = $1 AND created_at > NOW() - INTERVAL '30 days' GROUP BY type`, [scope.dataId]).catch(() => []),
  ]);
  const counts = new Map(recent.map((r) => [r.type, Number(r.n)]));
  const events = EVENT_TYPES.map((type) => {
    const sample = samplePayload(type);
    return { type, entity: sample.entity, sample: { id: "evt_sample", type, entity: sample.entity, entity_id: "sample_id", data: sample.data, created_at: sample.created_at }, recent_count: counts.get(type) ?? 0 };
  });
  const tools = listTools().map((t) => ({ name: t.name, module: t.module, description: t.description, scope: t.scope, schema: toolInputSchema(t), gated: t.scope === "write" && t.requiresApproval !== false }));
  return NextResponse.json({
    events,
    tools,
    condition_ops: CONDITION_OPS.map((op) => ({ op, label: CONDITION_OP_LABELS[op] })),
    step_kinds: STEP_KINDS.map((kind) => ({ kind, label: STEP_KIND_LABELS[kind] })),
    agents,
    context_paths: ["event.type", "event.entity", "event.entity_id", "event.data", "entity", "org.id", "org.name", "automation.id", "automation.name", "now"],
  });
}
