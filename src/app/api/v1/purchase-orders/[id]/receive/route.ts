import { getPurchaseOrder } from "@/lib/procurement/purchase-orders";
import { OverReceiptError, receivePurchaseOrder } from "@/lib/procurement/receiving";
import { ROUTES } from "@/lib/public-api/registry";
import { ApiError } from "@/lib/public-api/envelope";
import { op, libCall, mustFind } from "@/lib/public-api/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = op(ROUTES.receivePurchaseOrder, async ({ principal, params, body }) => {
  mustFind(await getPurchaseOrder(principal.dataId, params.id), "Purchase order");
  const out = await libCall(async () => {
    try {
      return await receivePurchaseOrder(principal.dataId, params.id, body, `api_key:${principal.keyId}`);
    } catch (err) {
      if (err instanceof OverReceiptError) throw new ApiError(409, "conflict", err.message);
      throw err;
    }
  });
  return { data: { purchase_order: out.purchaseOrder, receipt: out.receipt, recosted: out.recosted } };
});
