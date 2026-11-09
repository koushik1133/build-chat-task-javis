import { NextResponse, type NextRequest } from "next/server";
import { publicCatalog } from "@/lib/storefront/catalog";
import { NO_STORE, notFound, resolveShop, shopError, shopRateLimit } from "@/lib/storefront/http";
import { getBillingSettings } from "@/lib/money/settings";
import { getBranding } from "@/lib/branding";
import { withRequestContext } from "@/lib/log/context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ org: string }> };

/** GET /api/shop/[org] — storefront settings (public subset) + visible catalog. */
async function getHandler(req: NextRequest, ctx: Ctx) {
  const block = await shopRateLimit(req, "catalog");
  if (block) return block;
  try {
    const pub = await resolveShop(ctx);
    if (!pub) return notFound();
    const sf = pub.storefront;
    const [items, billing, branding] = await Promise.all([publicCatalog(pub.dataId, sf.slug), getBillingSettings(pub.dataId), getBranding(pub.dataId)]);
    return NextResponse.json(
      {
        shop: {
          slug: sf.slug,
          name: sf.title ?? pub.orgName,
          brand_name: branding.brand_name,
          intro_md: sf.intro_md,
          terms_md: sf.terms_md,
          currency: sf.currency,
          collect_shipping: sf.collect_shipping,
          shipping_flat_minor: sf.shipping_flat_minor,
          pickup_enabled: sf.pickup_enabled,
          prices_include_tax: billing.prices_include_tax,
          max_qty_per_line: sf.settings.max_qty_per_line,
          support_email: branding.support_email,
        },
        items,
      },
      { headers: NO_STORE }
    );
  } catch (err) {
    return shopError(err, "shop.GET");
  }
}

export const GET = withRequestContext(getHandler);
