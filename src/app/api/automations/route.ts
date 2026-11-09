import { NextResponse } from "next/server";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { rateLimitAsync } from "@/lib/request-limits";
import { AutomationDefinitionSchema } from "@/lib/automations/schema";
import { createAutomation, listAutomations, redactAutomationSecrets, runStats, toAutomationDTO } from "@/lib/automations/store";
import { recordAudit } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET: every automation (legacy rows converted on read) + per-automation run stats. */
export async function GET() {
  let scope;
  try {
    scope = await requireScope({ area: "agents", edit: false });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const [rows, stats] = await Promise.all([listAutomations(scope.dataId).catch(() => []), runStats(scope.dataId)]);
  const canEdit = scope.can("agents", true);
  const automations = rows.map(toAutomationDTO).map((a) => (canEdit ? a : redactAutomationSecrets(a))).map((a) => ({ ...a, stats: stats[a.id] ?? { total: 0, failed: 0, waiting: 0 } }));
  return NextResponse.json({ automations, workflows: automations });
}

/** POST: create a v2 automation. */
export async function POST(req: Request) {
  let scope;
  try {
    scope = await requireScope({ area: "agents", edit: true });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const rl = await rateLimitAsync(`automations:create:${scope.dataId}`, 60, 60_000);
  if (!rl.allowed) return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  const raw = await req.json().catch(() => null);
  if (!raw || typeof raw !== "object") return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  const parsed = AutomationDefinitionSchema.safeParse(raw);
  if (!parsed.success) return NextResponse.json({ error: "Invalid automation", details: parsed.error.flatten() }, { status: 400 });
  try {
    const row = await createAutomation(scope.dataId, parsed.data);
    void recordAudit({ dataId: scope.dataId, userId: scope.userId }, { action: "automation.created", entity: "automation", entityId: row.id, after: { name: parsed.data.name, trigger_type: parsed.data.trigger_type } }).catch(() => undefined);
    return NextResponse.json({ automation: toAutomationDTO(row) }, { status: 201 });
  } catch (err) {
    console.error("[automations] create failed:", err);
    return NextResponse.json({ error: "Failed to create automation" }, { status: 503 });
  }
}
