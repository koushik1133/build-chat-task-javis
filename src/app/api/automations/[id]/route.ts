import { NextResponse } from "next/server";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { AutomationDefinitionSchema, AutomationPatchSchema } from "@/lib/automations/schema";
import { definitionOf, deleteAutomation, getAutomation, redactAutomationSecrets, saveAutomation, toAutomationDTO } from "@/lib/automations/store";
import { recordAudit } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  let scope;
  try {
    scope = await requireScope({ area: "agents", edit: false });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await ctx.params;
  const row = await getAutomation(scope.dataId, id).catch(() => null);
  if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });
  const dto = toAutomationDTO(row);
  return NextResponse.json({ automation: scope.can("agents", true) ? dto : redactAutomationSecrets(dto) });
}

/** PATCH: partial update of the v2 definition (legacy rows are converted and persisted on first save). Accepts legacy `{status}` too. */
export async function PATCH(req: Request, ctx: Ctx) {
  let scope;
  try {
    scope = await requireScope({ area: "agents", edit: true });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await ctx.params;
  const raw = await req.json().catch(() => null);
  if (!raw || typeof raw !== "object") return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  const body = { ...(raw as Record<string, unknown>) };
  if (typeof body.status === "string") {
    body.enabled = body.status === "active";
    delete body.status;
  }
  const patch = AutomationPatchSchema.safeParse(body);
  if (!patch.success) return NextResponse.json({ error: "Invalid patch", details: patch.error.flatten() }, { status: 400 });
  const row = await getAutomation(scope.dataId, id).catch(() => null);
  if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });
  const current = definitionOf(row);
  const merged = AutomationDefinitionSchema.safeParse({
    name: current.name,
    description: current.description ?? null,
    trigger_type: current.trigger_type,
    trigger_config: current.trigger_config,
    conditions: current.conditions,
    steps: current.steps,
    autonomy: current.autonomy,
    enabled: current.enabled,
    ...patch.data,
  });
  if (!merged.success) return NextResponse.json({ error: "Invalid automation", details: merged.error.flatten() }, { status: 400 });
  const saved = await saveAutomation(scope.dataId, id, merged.data);
  if (!saved) return NextResponse.json({ error: "not found" }, { status: 404 });
  void recordAudit({ dataId: scope.dataId, userId: scope.userId }, { action: "automation.updated", entity: "automation", entityId: id, after: { enabled: merged.data.enabled, version: saved.version } }).catch(() => undefined);
  return NextResponse.json({ automation: toAutomationDTO(saved), ok: true });
}

export async function DELETE(_req: Request, ctx: Ctx) {
  let scope;
  try {
    scope = await requireScope({ area: "agents", edit: true });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await ctx.params;
  const ok = await deleteAutomation(scope.dataId, id).catch(() => false);
  if (!ok) return NextResponse.json({ error: "not found" }, { status: 404 });
  void recordAudit({ dataId: scope.dataId, userId: scope.userId }, { action: "automation.deleted", entity: "automation", entityId: id }).catch(() => undefined);
  return NextResponse.json({ ok: true });
}
