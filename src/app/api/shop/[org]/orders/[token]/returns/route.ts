import { NextResponse, type NextRequest } from "next/server";
import { readCappedText } from "@/lib/request-limits";
import { NO_STORE, notFound, resolveShop, shopRateLimit } from "@/lib/storefront/http";
import { resolveOrderToken } from "@/lib/storefront/orders";
import { createReturnRequest, publicReturnInfo, ReturnRequestSchema } from "@/lib/shipping/returns";
import { ShippingError } from "@/lib/shipping/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ org: string; token: string }> };

/** GET — return eligibility, returnable lines and existing returns for the token's order. */
export async function GET(req: NextRequest, ctx: Ctx) {
  const block = await shopRateLimit(req, "order-returns", 60);
  if (block) return block;
  try {
    const pub = await resolveShop(ctx);
    if (!pub) return notFound();
    const order = await resolveOrderToken(pub.dataId, (await ctx.params).token);
    if (!order) return notFound();
    return NextResponse.json({ returns: await publicReturnInfo(pub.dataId, order) }, { headers: NO_STORE });
  } catch (err) {
    console.error("[shop.returns.GET]", err);
    return NextResponse.json({ error: "internal_error" }, { status: 500, headers: NO_STORE });
  }
}

/** POST { reason, items:[{product_id, qty}], resolution? } — the customer opens a return (window and quantities enforced server-side). */
export async function POST(req: NextRequest, ctx: Ctx) {
  const block = await shopRateLimit(req, "order-returns-write", 10);
  if (block) return block;
  try {
    const pub = await resolveShop(ctx);
    if (!pub) return notFound();
    const order = await resolveOrderToken(pub.dataId, (await ctx.params).token);
    if (!order) return notFound();
    const text = await readCappedText(req, 16_384);
    if (text === null) return NextResponse.json({ error: "payload_too_large" }, { status: 413 });
    let json: unknown;
    try {
      json = JSON.parse(text || "{}");
    } catch {
      return NextResponse.json({ error: "invalid_json" }, { status: 400 });
    }
    const parsed = ReturnRequestSchema.safeParse(json);
    if (!parsed.success) return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400, headers: NO_STORE });
    const ret = await createReturnRequest(pub.dataId, order.id, parsed.data, { source: "customer" });
    return NextResponse.json({ return: { id: ret.id, status: ret.status } }, { status: 201, headers: NO_STORE });
  } catch (err) {
    if (err instanceof ShippingError) return NextResponse.json({ error: err.code, detail: err.message }, { status: err.status, headers: NO_STORE });
    console.error("[shop.returns.POST]", err);
    return NextResponse.json({ error: "internal_error" }, { status: 500, headers: NO_STORE });
  }
}
