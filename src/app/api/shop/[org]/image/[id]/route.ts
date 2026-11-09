import { NextResponse, type NextRequest } from "next/server";
import { queryOne } from "@/lib/dsql";
import { openAttachment } from "@/lib/attachments/store";
import { notFound, resolveShop, shopError, shopRateLimit } from "@/lib/storefront/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ org: string; id: string }> };

/**
 * GET /api/shop/[org]/image/[id] — public product image. Only image attachments
 * on a *visible* storefront product with visibility "portal" are served.
 */
export async function GET(req: NextRequest, ctx: Ctx) {
  const block = await shopRateLimit(req, "image", 300);
  if (block) return block;
  try {
    const pub = await resolveShop(ctx);
    if (!pub) return notFound();
    const { id } = await ctx.params;
    if (!/^[A-Za-z0-9-]{8,100}$/.test(id)) return notFound();
    const ok = await queryOne<{ id: string }>(
      `SELECT a.id FROM attachments a
         JOIN storefront_products sp ON sp.product_id = a.entity_id AND sp.user_id = a.user_id
        WHERE a.id = $1 AND a.user_id = $2 AND a.entity_kind = 'product' AND a.visibility = 'portal' AND a.deleted_at IS NULL
          AND a.content_type LIKE 'image/%' AND sp.visible = TRUE AND sp.image_url = $3`,
      [id, pub.dataId, `attachment:${id}`]
    );
    if (!ok) return notFound();
    const opened = await openAttachment(pub.dataId, id);
    if (!opened) return notFound();
    if (opened.url) return NextResponse.redirect(opened.url, { status: 302, headers: { "Cache-Control": "public, max-age=300" } });
    return new Response(new Uint8Array(opened.bytes ?? Buffer.alloc(0)), {
      status: 200,
      headers: { "Content-Type": opened.attachment.content_type, "Cache-Control": "public, max-age=3600", "X-Content-Type-Options": "nosniff" },
    });
  } catch (err) {
    return shopError(err, "shop.image.GET");
  }
}
