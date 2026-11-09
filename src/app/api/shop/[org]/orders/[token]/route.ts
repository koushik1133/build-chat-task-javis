import { NextResponse, type NextRequest } from "next/server";
import { startCheckout } from "@/lib/storefront/checkout";
import { NO_STORE, notFound, resolveShop, shopError, shopRateLimit } from "@/lib/storefront/http";
import { resolveOrderToken, toPublicOrder } from "@/lib/storefront/orders";
import { shipmentsForOrder } from "@/lib/shipping/shipments";
import { publicReturnInfo } from "@/lib/shipping/returns";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ org: string; token: string }> };

/** GET /api/shop/[org]/orders/[token] — public order status via a recipient-bound share token. */
export async function GET(req: NextRequest, ctx: Ctx) {
  const block = await shopRateLimit(req, "order");
  if (block) return block;
  try {
    const pub = await resolveShop(ctx);
    if (!pub) return notFound();
    const { token } = await ctx.params;
    const order = await resolveOrderToken(pub.dataId, token);
    if (!order) return notFound();
    // Shipping is additive: a failure here must never hide the order itself.
    const shipments = (await shipmentsForOrder(pub.dataId, order.id).catch(() => [])).filter((s) => !s.return_id && s.status !== "void").map((s) => ({ carrier: s.carrier, tracking_number: s.tracking_number, status: s.status, status_label: s.status_label }));
    const returns = order.status === "paid" || order.status === "fulfilled" ? await publicReturnInfo(pub.dataId, order).catch(() => null) : null;
    return NextResponse.json({ order: toPublicOrder(order), can_pay: order.status === "pending_payment", shipments, returns }, { headers: NO_STORE });
  } catch (err) {
    return shopError(err, "shop.order.GET");
  }
}

/** POST /api/shop/[org]/orders/[token] — pay again: a fresh provider checkout for a pending order. */
export async function POST(req: NextRequest, ctx: Ctx) {
  const block = await shopRateLimit(req, "order-pay", 20);
  if (block) return block;
  try {
    const pub = await resolveShop(ctx);
    if (!pub) return notFound();
    const { token } = await ctx.params;
    const order = await resolveOrderToken(pub.dataId, token);
    if (!order) return notFound();
    if (order.status !== "pending_payment") return NextResponse.json({ error: "not_payable", detail: `Order is ${order.status_label.toLowerCase()}` }, { status: 409, headers: NO_STORE });
    const pay = await startCheckout(pub.dataId, order);
    return NextResponse.json({ pay_url: pay.url, provider: pay.provider }, { headers: NO_STORE });
  } catch (err) {
    return shopError(err, "shop.order.POST");
  }
}
