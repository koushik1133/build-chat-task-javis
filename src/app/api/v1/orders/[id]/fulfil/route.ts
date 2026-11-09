import { ROUTES } from "@/lib/public-api/registry";
import { op } from "@/lib/public-api/handler";
import { fulfillOrder } from "@/lib/storefront/orders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = op(ROUTES.fulfilOrder, async ({ principal, params }) => ({ data: await fulfillOrder(principal.dataId, params.id, `api_key:${principal.keyId}`) }));
