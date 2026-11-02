import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { deleteSubscription, getSubscription, rotateSecret, updateSubscription, WebhookValidationError } from "@/lib/webhooks/subscriptions";
import { listDeliveries } from "@/lib/webhooks/dispatch";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

const PatchSchema = z
  .object({
    url: z.string().trim().url().max(2048).optional(),
    event_types: z.array(z.string().trim().min(1).max(80)).min(1).max(100).optional(),
    description: z.string().trim().max(200).nullable().optional(),
    active: z.boolean().optional(),
    rotate_secret: z.boolean().optional(),
  })
  .strict();

/** GET /api/webhooks/[id] — subscription + recent deliveries. */
export async function GET(_req: NextRequest, { params }: Ctx) {
  try {
    const scope = await requireScope({ area: "settings" });
    const { id } = await params;
    const subscription = await getSubscription(scope.dataId, id);
    if (!subscription) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const deliveries = await listDeliveries(scope.dataId, id, 50);
    return NextResponse.json({ subscription, deliveries });
  } catch (err) {
    return scopeErrorResponse(err) ?? (console.error("[webhooks] get failed:", err), NextResponse.json({ error: "Could not load the webhook." }, { status: 500 }));
  }
}

export async function PATCH(req: NextRequest, { params }: Ctx) {
  try {
    const scope = await requireScope({ area: "settings", edit: true });
    const { id } = await params;
    const parsed = PatchSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid body" }, { status: 400 });
    const { rotate_secret, ...patch } = parsed.data;
    const subscription = await updateSubscription(scope.dataId, id, patch);
    const secret = rotate_secret ? await rotateSecret(scope.dataId, id) : undefined;
    return NextResponse.json(secret ? { subscription, secret } : { subscription });
  } catch (err) {
    if (err instanceof WebhookValidationError) return NextResponse.json({ error: err.message }, { status: 422 });
    if (err instanceof Error && /not found/i.test(err.message)) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return scopeErrorResponse(err) ?? (console.error("[webhooks] update failed:", err), NextResponse.json({ error: "Could not update the webhook." }, { status: 500 }));
  }
}

export async function DELETE(_req: NextRequest, { params }: Ctx) {
  try {
    const scope = await requireScope({ area: "settings", edit: true });
    const { id } = await params;
    const ok = await deleteSubscription(scope.dataId, id);
    if (!ok) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return scopeErrorResponse(err) ?? (console.error("[webhooks] delete failed:", err), NextResponse.json({ error: "Could not delete the webhook." }, { status: 500 }));
  }
}
