import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { parseBody } from "@/lib/money/http";
import { isPushSubscription } from "@/lib/push/send";
import { deliverPushForUser, isPushConfigured, listSubscriptions, PushEndpointOwnedError, removeSubscription, saveSubscription } from "@/lib/push/sink";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const SubscriptionSchema = z
  .object({
    endpoint: z.string().url().max(2048),
    expirationTime: z.number().nullable().optional(),
    keys: z.object({ p256dh: z.string().min(1).max(200), auth: z.string().min(1).max(100) }).strict(),
  })
  .strict();

const PostBody = z
  .object({
    subscription: SubscriptionSchema.optional(),
    /** Send a test notification to the caller's devices instead of subscribing. */
    test: z.boolean().optional(),
  })
  .strict();

const DeleteBody = z.object({ endpoint: z.string().url().max(2048) }).strict();

/** GET — the caller's own subscriptions (count + user agents). */
export async function GET() {
  let scope;
  try {
    scope = await requireScope();
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const rows = await listSubscriptions(scope.dataId, scope.userId).catch(() => []);
  return NextResponse.json({
    configured: isPushConfigured(),
    subscriptions: rows.map((r) => ({ id: r.id, endpoint: r.endpoint, userAgent: r.user_agent, createdAt: r.created_at })),
  });
}

/** POST {subscription} → saves it; POST {test:true} → sends a test push. */
export async function POST(req: NextRequest) {
  let scope;
  try {
    scope = await requireScope();
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!isPushConfigured()) return NextResponse.json({ error: "push_not_configured", detail: "Set VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT." }, { status: 503 });

  const parsed = await parseBody(req, PostBody, 8_192);
  if (!parsed.ok) return parsed.res;

  if (parsed.data.test) {
    const result = await deliverPushForUser(scope.dataId, {
      title: "KernelHub notifications are on",
      body: `Push works on this device. Workspace: ${scope.orgName}.`,
      url: "/settings/notifications",
      tag: "push-test",
    }, { memberId: scope.userId });
    return NextResponse.json({ ok: result.sent > 0, ...result });
  }

  const sub = parsed.data.subscription;
  if (!sub || !isPushSubscription(sub)) return NextResponse.json({ error: "invalid_subscription" }, { status: 400 });
  try {
    const id = await saveSubscription(scope.dataId, scope.userId, sub, req.headers.get("user-agent"));
    return NextResponse.json({ ok: true, id }, { status: 201 });
  } catch (err) {
    if (err instanceof PushEndpointOwnedError) return NextResponse.json({ error: "endpoint_in_use" }, { status: 409 });
    console.error("[push:subscribe]", err);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}

/** DELETE {endpoint} — remove this device's subscription. Idempotent. */
export async function DELETE(req: NextRequest) {
  let scope;
  try {
    scope = await requireScope();
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const parsed = await parseBody(req, DeleteBody, 4_096);
  if (!parsed.ok) return parsed.res;
  const removed = await removeSubscription(scope.dataId, parsed.data.endpoint).catch((err) => {
    console.error("[push:unsubscribe]", err);
    return 0;
  });
  return NextResponse.json({ ok: true, removed });
}
