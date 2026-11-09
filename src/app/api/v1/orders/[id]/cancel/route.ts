import { ROUTES } from "@/lib/public-api/registry";
import { op } from "@/lib/public-api/handler";
import { cancelOrder } from "@/lib/storefront/orders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = op(ROUTES.cancelOrder, async ({ principal, params, body }) => ({
  data: await cancelOrder(principal.dataId, params.id, { reason: body.reason ?? null, restock: body.restock, actorId: `api_key:${principal.keyId}` }),
}));
