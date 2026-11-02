import { deleteSubscription, getSubscription, updateSubscription } from "@/lib/webhooks/subscriptions";
import { ROUTES } from "@/lib/public-api/registry";
import { ApiError } from "@/lib/public-api/envelope";
import { op, mustFind } from "@/lib/public-api/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = op(ROUTES.getWebhook, async ({ principal, params }) => ({ data: mustFind(await getSubscription(principal.dataId, params.id), "Webhook") }));

export const PATCH = op(ROUTES.updateWebhook, async ({ principal, params, body }) => ({ data: await updateSubscription(principal.dataId, params.id, body) }));

/** REST hook unsubscribe. */
export const DELETE = op(ROUTES.deleteWebhook, async ({ principal, params }) => {
  if (!(await deleteSubscription(principal.dataId, params.id))) throw ApiError.notFound("Webhook");
  return { data: { id: params.id, deleted: true as const } };
});
