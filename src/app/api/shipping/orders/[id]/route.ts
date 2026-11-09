import { NextResponse, type NextRequest } from "next/server";
import { requireScope } from "@/lib/auth/scope";
import { paramId } from "@/lib/money/http";
import { shippingError } from "@/lib/shipping/http";
 import { getOrder } from "@/lib/storefront/orders";
import { shipmentsForOrder, getOrderShipping } from "@/lib/shipping/shipments";
import { listReturns, returnEligibility, refundableMinor, suggestedRefund } from "@/lib/shipping/returns";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/shipping/orders/[id] — everything the order drawer's Shipping section needs. */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const scope = await requireScope({ area: "billing", edit: false });
    const order = await getOrder(scope.dataId, await paramId(ctx));
    if (!order) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const [shipments, returns, method, eligibility, refundable] = await Promise.all([shipmentsForOrder(scope.dataId, order.id), listReturns(scope.dataId, { orderId: order.id, limit: 20 }), getOrderShipping(scope.dataId, order.id), returnEligibility(scope.dataId, order), refundableMinor(order, scope.dataId)]);
    return NextResponse.json({ shipments, returns: returns.map((r) => ({ ...r, suggested_refund_minor: suggestedRefund(order, r.items) })), shipping_method: method.method, shipping_quote: method.quote, return_eligibility: eligibility, refundable_minor: Math.max(0, refundable.paid - refundable.refunded) });
  } catch (err) {
    return shippingError(err, "shipping.order.GET");
  }
}
