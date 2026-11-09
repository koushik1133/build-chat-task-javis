import { NextResponse, type NextRequest } from "next/server";
import { requireScope } from "@/lib/auth/scope";
import { paramId, parseBody } from "@/lib/money/http";
import { financeErrorResponse } from "@/lib/finance/http";
import { OverReceiptError, ReceiveLinesSchema, receivePurchaseOrder } from "@/lib/procurement/receiving";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/purchase-orders/[id]/receive { lines: [{product_id, qty}], note? } */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const scope = await requireScope({ area: "billing", edit: true });
    const body = await parseBody(req, ReceiveLinesSchema);
    if (!body.ok) return body.res;
    const out = await receivePurchaseOrder(scope.dataId, await paramId(ctx), body.data, scope.userId);
    return NextResponse.json({ purchase_order: out.purchaseOrder, receipt: out.receipt, recosted: out.recosted });
  } catch (err) {
    if (err instanceof OverReceiptError) return NextResponse.json({ error: "over_receipt", detail: err.message, lines: err.details }, { status: 409 });
    return financeErrorResponse(err, "purchase-orders.id.receive.POST");
  }
}
