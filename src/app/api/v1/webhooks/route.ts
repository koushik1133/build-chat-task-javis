import { createSubscription, listSubscriptions } from "@/lib/webhooks/subscriptions";
import { ROUTES } from "@/lib/public-api/registry";
import { op } from "@/lib/public-api/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = op(ROUTES.listWebhooks, async ({ principal }) => ({ data: await listSubscriptions(principal.dataId), meta: { next_cursor: null } }));

/** REST hook subscribe: returns the signing secret exactly once. */
export const POST = op(ROUTES.createWebhook, async ({ principal, body }) => {
  const { subscription, secret } = await createSubscription(principal.dataId, {
    url: body.url,
    event_types: body.event_types,
    description: body.description ?? null,
    created_by: `api_key:${principal.keyId}`,
  });
  return { data: { ...subscription, secret }, status: 201 };
});
