import { getPurchaseOrder } from "@/lib/procurement/purchase-orders";
import { ROUTES } from "@/lib/public-api/registry";
import { op, mustFind } from "@/lib/public-api/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = op(ROUTES.getPurchaseOrder, async ({ principal, params }) => ({ data: mustFind(await getPurchaseOrder(principal.dataId, params.id), "Purchase order") }));
