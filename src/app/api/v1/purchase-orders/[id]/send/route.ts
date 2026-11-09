import { getPurchaseOrder, sendPurchaseOrder } from "@/lib/procurement/purchase-orders";
import { ROUTES } from "@/lib/public-api/registry";
import { op, libCall, mustFind } from "@/lib/public-api/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = op(ROUTES.sendPurchaseOrder, async ({ principal, params, body }) => {
  mustFind(await getPurchaseOrder(principal.dataId, params.id), "Purchase order");
  const out = await libCall(() => sendPurchaseOrder(principal.dataId, params.id, body));
  return { data: out.purchaseOrder };
});
