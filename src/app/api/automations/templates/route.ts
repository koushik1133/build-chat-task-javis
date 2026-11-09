import { NextResponse } from "next/server";
import { z } from "zod";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { ensureToolsLoaded } from "@/lib/agents/tools/index";
import { installTemplate, toAutomationDTO } from "@/lib/automations/store";
import { AUTOMATION_TEMPLATES } from "@/lib/automations/templates";
import { recordAudit } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await requireScope({ area: "agents", edit: false });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return NextResponse.json({ templates: AUTOMATION_TEMPLATES });
}

const Body = z.object({ key: z.string().min(1).max(80) }).strict();

export async function POST(req: Request) {
  let scope;
  try {
    scope = await requireScope({ area: "agents", edit: true });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const body = Body.safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: "key required" }, { status: 400 });
  ensureToolsLoaded();
  try {
    const { row, swapped } = await installTemplate(scope.dataId, body.data.key);
    void recordAudit({ dataId: scope.dataId, userId: scope.userId }, { action: "automation.template_installed", entity: "automation", entityId: row.id, after: { key: body.data.key } }).catch(() => undefined);
    return NextResponse.json({ automation: toAutomationDTO(row), swapped_tool: swapped }, { status: 201 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "install failed";
    return NextResponse.json({ error: msg }, { status: /unknown template/.test(msg) ? 404 : 503 });
  }
}
