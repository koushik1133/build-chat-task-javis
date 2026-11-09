import { NextRequest, NextResponse } from "next/server";
import { recordAudit } from "@/lib/audit";
import { ChatValidationError, createIntegration, listIntegrations } from "@/lib/chatops/subscriptions";
import { CHAT_PROVIDER_LABELS, CHAT_PROVIDERS } from "@/lib/chatops/types";
import { EVENT_TYPES } from "@/lib/events/bus";
import { tableExists } from "@/lib/table-exists";
import { chatScope, CreateBody, isResponse } from "./_shared";

export const dynamic = "force-dynamic";

export async function GET() {
  const scope = await chatScope(false);
  if (isResponse(scope)) return scope;
  try {
    const ready = await tableExists("chat_integrations");
    const integrations = ready ? await listIntegrations(scope.dataId) : [];
    return NextResponse.json({
      integrations,
      providers: CHAT_PROVIDERS.map((id) => ({ id, label: CHAT_PROVIDER_LABELS[id] })),
      event_types: EVENT_TYPES,
      migrated: ready,
      canEdit: scope.can("settings", true),
    });
  } catch (err) {
    console.error("[chat-integrations] list failed:", err);
    return NextResponse.json({ error: "Could not load chat integrations." }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const scope = await chatScope(true);
  if (isResponse(scope)) return scope;
  const parsed = CreateBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request", details: parsed.error.flatten() }, { status: 400 });
  try {
    const integration = await createIntegration(scope.dataId, parsed.data);
    await recordAudit(scope, { action: "chat_integration.create", entity: "chat_integration", entityId: integration.id });
    return NextResponse.json({ integration }, { status: 201 });
  } catch (err) {
    if (err instanceof ChatValidationError) return NextResponse.json({ error: err.message }, { status: 400 });
    console.error("[chat-integrations] create failed:", err);
    return NextResponse.json({ error: "Could not save the integration." }, { status: 500 });
  }
}
