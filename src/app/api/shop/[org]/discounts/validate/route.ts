import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { applyDiscounts } from "@/lib/engagement/discounts";
import { giftCardAttemptAllowed } from "@/lib/engagement/giftcards";
import { queryOne } from "@/lib/dsql";
import { resolveDocumentTotals } from "@/lib/money/tax-rates";
import { readCappedText } from "@/lib/request-limits";
import { resolveShareToken } from "@/lib/share-tokens";
import { cartToLineItems, getCartByToken } from "@/lib/storefront/cart";
import { visibleProductsByIds } from "@/lib/storefront/catalog";
import { NO_STORE, clientIp, notFound, readCartToken, resolveShop, shopError, shopRateLimit } from "@/lib/storefront/http";
import { parseCartItems, shippingCharge } from "@/lib/storefront/pure";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z
  .object({
    voucher_codes: z.array(z.string().trim().min(1).max(40)).max(5).optional(),
    points: z.number().int().min(0).max(10_000_000).optional(),
    gift_card: z.string().trim().max(40).optional(),
    portal_token: z.string().max(200).optional(),
    email: z.string().trim().toLowerCase().email().max(320).optional(),
    pickup: z.boolean().optional(),
  })
  .strict();

/** POST /api/shop/[org]/discounts/validate -> computed preview for the cart in the cookie. Nothing is redeemed. */
export async function POST(req: NextRequest, ctx: { params: Promise<{ org: string }> }) {
  const block = await shopRateLimit(req, "discount", 40);
  if (block) return block;
  try {
    const pub = await resolveShop(ctx);
    if (!pub) return notFound();
    const text = await readCappedText(req, 4096);
    let json: unknown = null;
    try { json = JSON.parse(text || "null"); } catch { /* handled below */ }
    const parsed = Body.safeParse(json);
    if (!parsed.success) return NextResponse.json({ error: "invalid_body" }, { status: 400, headers: NO_STORE });
    const b = parsed.data;
    if (b.gift_card && !(await giftCardAttemptAllowed(clientIp(req)))) return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: NO_STORE });
    const cart = await getCartByToken(pub.dataId, readCartToken(req, pub.storefront.slug));
    const items = cart ? parseCartItems(cart.items) : [];
    if (!cart || items.length === 0) return NextResponse.json({ error: "empty_cart", detail: "Your cart is empty" }, { status: 400, headers: NO_STORE });
    const products = await visibleProductsByIds(pub.dataId, items.map((i) => i.product_id));
    const lines = cartToLineItems(items.filter((i) => products.has(i.product_id)), products);
    let contactId: string | null = null;
    if (b.portal_token) {
      const share = await resolveShareToken("portal", b.portal_token);
      if (share && share.user_id === pub.dataId) contactId = share.entity_id;
    }
    // Points/balances are only previewed for an authenticated portal contact; an email alone must never reveal a rewards balance.
    const pointsRequested = (b.points ?? 0) > 0;
    const portalContact = contactId;
    if (!contactId && b.email) contactId = (await queryOne<{ id: string }>(`SELECT id FROM crm_contacts WHERE user_id = $1 AND lower(email) = $2 AND deleted_at IS NULL ORDER BY created_at ASC LIMIT 1`, [pub.dataId, b.email]))?.id ?? null;
    const r = await applyDiscounts(pub.dataId, { currency: pub.storefront.currency, items: lines, contactId, voucherCodes: b.voucher_codes, loyaltyPoints: portalContact ? b.points : undefined, giftCardCode: b.gift_card });
    if (pointsRequested && !portalContact) r.problems.push({ field: "points", code: "no_account", message: "Sign in to your rewards account to use points." });
    const goods = await resolveDocumentTotals(pub.dataId, [...lines, ...r.lines]);
    const shipping = r.freeShipping ? 0 : shippingCharge(pub.storefront, b.pickup === true);
    const total = goods.total_minor + shipping;
    return NextResponse.json(
      {
        discount_minor: r.discountMinor,
        free_shipping: r.freeShipping,
        vouchers: r.vouchers.map((v) => ({ code: v.voucher.code_upper, name: v.voucher.name, discount_minor: v.discountMinor })),
        points: r.points,
        gift_card: r.giftCard ? { last4: r.giftCard.last4, balance_minor: r.giftCard.balance_minor, applied_minor: Math.min(r.giftCard.balance_minor, total) } : null,
        problems: r.problems,
        subtotal_minor: goods.subtotal_minor,
        tax_minor: goods.tax_minor,
        shipping_minor: shipping,
        total_minor: total,
        payable_minor: Math.max(0, total - (r.giftCard ? Math.min(r.giftCard.balance_minor, total) : 0)),
        currency: pub.storefront.currency,
      },
      { headers: NO_STORE }
    );
  } catch (err) {
    return shopError(err, "shop.discounts.validate");
  }
}
