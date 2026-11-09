import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { readCappedText } from "@/lib/request-limits";
import { getCartByToken } from "@/lib/storefront/cart";
import { NO_STORE, notFound, readCartToken, resolveShop, shopError, shopRateLimit } from "@/lib/storefront/http";
import { ShippingAddressSchema, parseCartItems } from "@/lib/storefront/pure";
import { quoteShipping } from "@/lib/shipping/quote";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({ address: ShippingAddressSchema }).strict();

/** POST /api/shop/[org]/shipping-quote — { address } + the cart cookie → shipping options. No address is logged or stored. */
export async function POST(req: NextRequest, ctx: { params: Promise<{ org: string }> }) {
  const block = await shopRateLimit(req, "ship-quote", 30);
  if (block) return block;
  try {
    const pub = await resolveShop(ctx);
    if (!pub) return notFound();
    const cart = await getCartByToken(pub.dataId, readCartToken(req, pub.storefront.slug));
    if (!cart) return NextResponse.json({ error: "empty_cart", detail: "Your cart is empty or has expired" }, { status: 400, headers: NO_STORE });
    const text = await readCappedText(req, 4_096);
    if (text === null) return NextResponse.json({ error: "payload_too_large" }, { status: 413 });
    let json: unknown;
    try {
      json = JSON.parse(text || "{}");
    } catch {
      return NextResponse.json({ error: "invalid_json" }, { status: 400 });
    }
    const parsed = Body.safeParse(json);
    if (!parsed.success) return NextResponse.json({ error: "invalid_body" }, { status: 400, headers: NO_STORE });
    const items = parseCartItems(cart.items);
    if (items.length === 0) return NextResponse.json({ error: "empty_cart" }, { status: 400, headers: NO_STORE });
    const quote = await quoteShipping(pub.dataId, { items, address: parsed.data.address, currency: pub.storefront.currency });
    return NextResponse.json(
      {
        rules_active: quote.rules_active,
        currency: pub.storefront.currency,
        shipping_tax_bp: pub.storefront.settings.shipping_tax_bp ?? 0,
        options: quote.options.map((o) => ({ id: o.id, label: o.label, price_minor: o.price_minor, days_min: o.days_min, days_max: o.days_max, carrier: o.carrier })),
      },
      { headers: NO_STORE }
    );
  } catch (err) {
    return shopError(err, "shop.shipping-quote");
  }
}
