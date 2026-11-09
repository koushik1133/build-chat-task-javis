import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { createSubscription, listSubscriptions, KNOWN_EVENT_TYPES, WebhookValidationError } from "@/lib/webhooks/subscriptions";
import { recordAudit } from "@/lib/audit";

export const runtime = "nodejs";

const CreateSchema = z
  .object({
    url: z.string().trim().url().max(2048),
    event_types: z.array(z.string().trim().min(1).max(80)).min(1).max(100).optional(),
    description: z.string().trim().max(200).nullable().optional(),
  })
  .strict();

/** GET /api/webhooks — subscriptions + the known event-type catalogue for the picker. */
export async function GET() {
  try {
    const scope = await requireScope({ area: "settings" });
    const subscriptions = await listSubscriptions(scope.dataId);
    return NextResponse.json({ subscriptions, event_types: KNOWN_EVENT_TYPES });
  } catch (err) {
    return scopeErrorResponse(err) ?? (console.error("[webhooks] list failed:", err), NextResponse.json({ error: "Could not load webhooks." }, { status: 500 }));
  }
}

/** POST /api/webhooks — create; the secret is returned once. */
export async function POST(req: NextRequest) {
  try {
    const scope = await requireScope({ area: "settings", edit: true });
    const parsed = CreateSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid body" }, { status: 400 });
    const { subscription, secret } = await createSubscription(scope.dataId, { ...parsed.data, created_by: scope.userId });
    await recordAudit(scope, { action: "create", entity: "webhook", entityId: (subscription as { id?: string }).id ?? null, after: { url_host: new URL(parsed.data.url).host }, req });
    return NextResponse.json({ subscription, secret }, { status: 201 });
  } catch (err) {
    if (err instanceof WebhookValidationError) return NextResponse.json({ error: err.message }, { status: 422 });
    return scopeErrorResponse(err) ?? (console.error("[webhooks] create failed:", err), NextResponse.json({ error: "Could not create the webhook." }, { status: 500 }));
  }
}
