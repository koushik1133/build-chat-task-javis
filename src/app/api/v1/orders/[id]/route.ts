import { ROUTES } from "@/lib/public-api/registry";
import { mustFind, op } from "@/lib/public-api/handler";
import { getOrder } from "@/lib/storefront/orders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = op(ROUTES.getOrder, async ({ principal, params }) => ({ data: mustFind(await getOrder(principal.dataId, params.id), "Order") }));
