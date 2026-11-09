import { NextResponse, type NextRequest } from "next/server";
import { readCappedText } from "@/lib/request-limits";
import { getCartByToken } from "@/lib/storefront/cart";
import { CheckoutSchema, createOrderFromCart } from "@/lib/storefront/checkout";
import { NO_STORE, clientIp, notFound, readCartToken, resolveShop, shopError, shopRateLimit } from "@/lib/storefront/http";
import { toPublicOrder } from "@/lib/storefront/orders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ org: string }> };

/** POST /api/shop/[org]/checkout — { name, email, phone?, shipping?, consent?, notes? } → 201 { order, status_url, pay_url }. */
export async function POST(req: NextRequest, ctx: Ctx) {
  const block = await shopRateLimit(req, "checkout", 20);
  if (block) return block;
  try {
    const pub = await resolveShop(ctx);
    if (!pub) return notFound();
    const cart = await getCartByToken(pub.dataId, readCartToken(req, pub.storefront.slug));
    if (!cart) return NextResponse.json({ error: "empty_cart", detail: "Your cart is empty or has expired" }, { status: 400, headers: NO_STORE });
    const text = await readCappedText(req, 16_384);
    if (text === null) return NextResponse.json({ error: "payload_too_large" }, { status: 413 });
    let json: unknown;
    try {
      json = JSON.parse(text || "{}");
    } catch {
      return NextResponse.json({ error: "invalid_json" }, { status: 400 });
    }
    const parsed = CheckoutSchema.safeParse(json);
    if (!parsed.success) return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
    const out = await createOrderFromCart(pub, cart, parsed.data, { ip: clientIp(req), ua: req.headers.get("user-agent") });
    const res = NextResponse.json({ order: toPublicOrder(out.order), status_url: out.status_url, status_token: out.status_token, pay_url: out.pay_url }, { status: 201, headers: NO_STORE });
    // The cart is spent: drop the cookie so the next visit starts clean.
    res.cookies.set(`kh_cart_${pub.storefront.slug.replace(/[^a-z0-9]/gi, "_")}`, "", { httpOnly: true, sameSite: "lax", path: "/", maxAge: 0 });
    return res;
  } catch (err) {
    return shopError(err, "shop.checkout.POST");
  }
}
