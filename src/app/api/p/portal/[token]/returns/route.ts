import { NextResponse, type NextRequest } from "next/server";
import { query } from "@/lib/dsql";
import { paramToken, publicRateLimit } from "@/lib/money/http";
import { readCappedText } from "@/lib/request-limits";
import { resolveShareToken } from "@/lib/share-tokens";
import { getOrder } from "@/lib/storefront/orders";
import { createReturnRequest, publicReturnInfo, ReturnRequestSchema } from "@/lib/shipping/returns";
import { ShippingError } from "@/lib/shipping/types";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ token: string }> };

/** The portal contact's own order (by contact id, or the contact's email on the order). */
async function ownOrder(dataId: string, contactId: string, orderId: string) {
  const own = await query<{ id: string }>(
    `SELECT o.id FROM orders o LEFT JOIN crm_contacts c ON c.id = $2 AND c.user_id = o.user_id
      WHERE o.user_id = $1 AND o.id = $3 AND (o.contact_id = $2 OR (c.email IS NOT NULL AND lower(o.customer_email) = lower(c.email))) LIMIT 1`,
    [dataId, contactId, orderId]
  );
  return own.length > 0 ? getOrder(dataId, orderId) : null;
}

/** GET ?order_id= — return info for one of the contact's orders. */
export async function GET(req: NextRequest, ctx: Ctx) {
  const limited = await publicRateLimit(req, "portal-returns", 60);
  if (limited) return limited;
  try {
    const share = await resolveShareToken("portal", await paramToken(ctx));
    if (!share) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const orderId = req.nextUrl.searchParams.get("order_id") ?? "";
    const order = await ownOrder(share.user_id, share.entity_id, orderId);
    if (!order) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ returns: await publicReturnInfo(share.user_id, order) });
  } catch (err) {
    console.error("[p.portal.returns.GET]", err);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}

const Body = ReturnRequestSchema.extend({ order_id: z.string().min(1).max(100) });

export async function POST(req: NextRequest, ctx: Ctx) {
  const limited = await publicRateLimit(req, "portal-returns-write", 10);
  if (limited) return limited;
  try {
    const share = await resolveShareToken("portal", await paramToken(ctx));
    if (!share) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const text = await readCappedText(req, 16_384);
    if (text === null) return NextResponse.json({ error: "payload_too_large" }, { status: 413 });
    let json: unknown;
    try {
      json = JSON.parse(text || "{}");
    } catch {
      return NextResponse.json({ error: "invalid_json" }, { status: 400 });
    }
    const parsed = Body.safeParse(json);
    if (!parsed.success) return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
    const order = await ownOrder(share.user_id, share.entity_id, parsed.data.order_id);
    if (!order) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const input = { reason: parsed.data.reason, resolution: parsed.data.resolution, items: parsed.data.items };
    const ret = await createReturnRequest(share.user_id, order.id, input, { source: "customer" });
    return NextResponse.json({ return: { id: ret.id, status: ret.status } }, { status: 201 });
  } catch (err) {
    if (err instanceof ShippingError) return NextResponse.json({ error: err.code, detail: err.message }, { status: err.status });
    console.error("[p.portal.returns.POST]", err);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
