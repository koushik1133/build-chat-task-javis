import { ROUTES } from "@/lib/public-api/registry";
import { mustFind, op } from "@/lib/public-api/handler";
import { cancelSubscription } from "@/lib/memberships/subscriptions";
import { getSubscription } from "@/lib/memberships/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = op(ROUTES.cancelSubscription, async ({ principal, params, body }) => {
  mustFind(await getSubscription(principal.dataId, params.id), "Subscription");
  return { data: await cancelSubscription(principal.dataId, params.id, { atPeriodEnd: body.at_period_end !== false, by: "staff", reason: body.reason ?? `api_key:${principal.keyId}` }) };
});
