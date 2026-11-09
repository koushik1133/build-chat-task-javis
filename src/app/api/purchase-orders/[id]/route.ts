import { NextResponse, type NextRequest } from "next/server";
import { requireScope } from "@/lib/auth/scope";
import { paramId, parseBody } from "@/lib/money/http";
import { financeErrorResponse } from "@/lib/finance/http";
import { deletePurchaseOrder, getPurchaseOrder, listReceipts, purchaseOrderProgress, PurchaseOrderPatchSchema, updatePurchaseOrder } from "@/lib/procurement/purchase-orders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/** GET /api/purchase-orders/[id] — the order plus receipts and per-product progress. */
export async function GET(_req: NextRequest, ctx: Ctx) {
  try {
    const scope = await requireScope({ area: "billing" });
    const purchase_order = await getPurchaseOrder(scope.dataId, await paramId(ctx));
    if (!purchase_order) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const [receipts, progress] = await Promise.all([listReceipts(scope.dataId, purchase_order.id), purchaseOrderProgress(scope.dataId, purchase_order)]);
    return NextResponse.json({ purchase_order, receipts, progress });
  } catch (err) {
    return financeErrorResponse(err, "purchase-orders.id.GET");
  }
}

export async function PATCH(req: NextRequest, ctx: Ctx) {
  try {
    const scope = await requireScope({ area: "billing", edit: true });
    const body = await parseBody(req, PurchaseOrderPatchSchema, 256_000);
    if (!body.ok) return body.res;
    const purchase_order = await updatePurchaseOrder(scope.dataId, await paramId(ctx), body.data);
    return NextResponse.json({ purchase_order });
  } catch (err) {
    return financeErrorResponse(err, "purchase-orders.id.PATCH");
  }
}

export async function DELETE(_req: NextRequest, ctx: Ctx) {
  try {
    const scope = await requireScope({ area: "billing", edit: true });
    const ok = await deletePurchaseOrder(scope.dataId, await paramId(ctx));
    if (!ok) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return financeErrorResponse(err, "purchase-orders.id.DELETE");
  }
}
