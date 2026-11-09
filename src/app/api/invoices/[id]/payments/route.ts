import { NextResponse, type NextRequest } from "next/server";
import { requireScope } from "@/lib/auth/scope";
import { getInvoice, listPayments } from "@/lib/money/invoices";
import { errorResponse, paramId } from "@/lib/money/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/invoices/[id]/payments — payment rows incl. refund columns (for the refund dialog). */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const scope = await requireScope({ area: "billing" });
    const id = await paramId(ctx);
    const invoice = await getInvoice(scope.dataId, id);
    if (!invoice) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const payments = (await listPayments(id)).map((p) => ({
      id: p.id,
      provider: p.provider,
      provider_ref: p.provider_ref,
      amount_minor: Number(p.amount_minor),
      currency: p.currency,
      status: p.status,
      created_at: p.created_at,
      refunded_minor: Number(p.refunded_minor ?? 0),
      refunded_at: p.refunded_at ?? null,
      refund_ref: p.refund_ref ?? null,
    }));
    return NextResponse.json({ payments });
  } catch (err) {
    return errorResponse(err, "invoices.id.payments.GET");
  }
}
