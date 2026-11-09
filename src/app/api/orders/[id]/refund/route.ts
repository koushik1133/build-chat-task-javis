import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireScope } from "@/lib/auth/scope";
import { errorResponse, paramId, parseBody } from "@/lib/money/http";
import { recordAudit } from "@/lib/audit";
import { getOrder, refundOrder } from "@/lib/storefront/orders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({ amount_minor: z.number().int().positive().max(1_000_000_000_000).optional(), reason: z.string().trim().max(500).nullable().optional() }).strict();

/** POST /api/orders/[id]/refund — { amount_minor?, reason? } refunds through the payment provider(s) of the linked invoice. */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const scope = await requireScope({ area: "billing", edit: true });
    const id = await paramId(ctx);
    const body = await parseBody(req, Body, 4_000);
    if (!body.ok) return body.res;
    const order = await getOrder(scope.dataId, id);
    if (!order) return NextResponse.json({ error: "not_found" }, { status: 404 });
    if (order.status === "pending_payment" || order.status === "cancelled") return NextResponse.json({ error: "bad_request", detail: "Nothing has been paid on this order" }, { status: 400 });
    const refunded_minor = await refundOrder(scope.dataId, order, { amount_minor: body.data.amount_minor ?? null, reason: body.data.reason ?? null });
    void recordAudit({ dataId: scope.dataId, userId: scope.userId }, { action: "order.refunded", entity: "order", entityId: id, after: { number: order.number, refunded_minor } });
    return NextResponse.json({ order: await getOrder(scope.dataId, id), refunded_minor }, { status: 201 });
  } catch (err) {
    return errorResponse(err, "orders.id.refund");
  }
}
