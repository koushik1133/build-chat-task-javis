import { NextRequest, NextResponse } from "next/server";
import { recordAudit } from "@/lib/audit";
import { ChatValidationError, deleteIntegration, updateIntegration } from "@/lib/chatops/subscriptions";
import { chatScope, isResponse, PatchBody } from "../_shared";

export const dynamic = "force-dynamic";

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const scope = await chatScope(true);
  if (isResponse(scope)) return scope;
  const { id } = await ctx.params;
  const parsed = PatchBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request", details: parsed.error.flatten() }, { status: 400 });
  try {
    const integration = await updateIntegration(scope.dataId, id, parsed.data);
    if (!integration) return NextResponse.json({ error: "Integration not found" }, { status: 404 });
    await recordAudit(scope, { action: "chat_integration.update", entity: "chat_integration", entityId: id });
    return NextResponse.json({ integration });
  } catch (err) {
    if (err instanceof ChatValidationError) return NextResponse.json({ error: err.message }, { status: 400 });
    console.error("[chat-integrations] update failed:", err);
    return NextResponse.json({ error: "Could not update the integration." }, { status: 500 });
  }
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const scope = await chatScope(true);
  if (isResponse(scope)) return scope;
  const { id } = await ctx.params;
  const ok = await deleteIntegration(scope.dataId, id);
  if (!ok) return NextResponse.json({ error: "Integration not found" }, { status: 404 });
  await recordAudit(scope, { action: "chat_integration.delete", entity: "chat_integration", entityId: id });
  return NextResponse.json({ ok: true });
}
