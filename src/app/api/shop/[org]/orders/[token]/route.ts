import { NextResponse, type NextRequest } from "next/server";
import { startCheckout } from "@/lib/storefront/checkout";
import { NO_STORE, notFound, resolveShop, shopError, shopRateLimit } from "@/lib/storefront/http";
import { resolveOrderToken, toPublicOrder } from "@/lib/storefront/orders";

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
    return NextResponse.json({ order: toPublicOrder(order), can_pay: order.status === "pending_payment" }, { headers: NO_STORE });
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
