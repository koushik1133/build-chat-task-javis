import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireScope } from "@/lib/auth/scope";
import { errorResponse, paramId, parseBody } from "@/lib/money/http";
import { getInvoice, listPayments } from "@/lib/money/invoices";
import { recordAudit } from "@/lib/audit";
import { cancelOrder, fulfillOrder, getOrder } from "@/lib/storefront/orders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/orders/[id] — order + linked invoice summary + payments. */
export async function GET(_req: NextRequest, ctx: Ctx) {
  try {
    const scope = await requireScope({ area: "billing", edit: false });
    const order = await getOrder(scope.dataId, await paramId(ctx));
    if (!order) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const invoice = order.invoice_id ? await getInvoice(scope.dataId, order.invoice_id) : null;
    const payments = order.invoice_id ? await listPayments(order.invoice_id) : [];
    return NextResponse.json({
      order,
      invoice: invoice ? { id: invoice.id, number: invoice.number, status: invoice.status, total_minor: invoice.total_minor, paid_minor: invoice.paid_minor } : null,
      payments: payments.map((p) => ({ id: p.id, provider: p.provider, provider_ref: p.provider_ref, amount_minor: Number(p.amount_minor), refunded_minor: Number(p.refunded_minor ?? 0), status: p.status, created_at: p.created_at })),
    });
  } catch (err) {
    return errorResponse(err, "orders.id.GET");
  }
}

const Patch = z
  .object({
    status: z.enum(["fulfilled", "cancelled"]),
    reason: z.string().trim().max(500).nullable().optional(),
    /** Cancelling a paid order: receive the goods back into stock. */
    restock: z.boolean().optional(),
  })
  .strict();

/** PATCH /api/orders/[id] — { status: "fulfilled" | "cancelled", reason?, restock? }. */
export async function PATCH(req: NextRequest, ctx: Ctx) {
  try {
    const scope = await requireScope({ area: "billing", edit: true });
    const id = await paramId(ctx);
    const body = await parseBody(req, Patch, 4_000);
    if (!body.ok) return body.res;
    const actor = { dataId: scope.dataId, userId: scope.userId };
    if (body.data.status === "fulfilled") {
      const order = await fulfillOrder(scope.dataId, id, scope.userId);
      void recordAudit(actor, { action: "order.fulfilled", entity: "order", entityId: id, after: { number: order.number } });
      return NextResponse.json({ order });
    }
    const out = await cancelOrder(scope.dataId, id, { reason: body.data.reason ?? null, restock: body.data.restock, actorId: scope.userId });
    void recordAudit(actor, { action: "order.cancelled", entity: "order", entityId: id, after: { number: out.order.number, refunded_minor: out.refunded_minor, released: out.released } });
    return NextResponse.json(out);
  } catch (err) {
    return errorResponse(err, "orders.id.PATCH");
  }
}
