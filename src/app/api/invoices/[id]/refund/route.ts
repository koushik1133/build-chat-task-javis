import { NextResponse, type NextRequest } from "next/server";
import { requireScope } from "@/lib/auth/scope";
import { RefundBodySchema, refundPayment } from "@/lib/money/credit-notes";
import { errorResponse, paramId, parseBody } from "@/lib/money/http";
import { recordAudit } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/invoices/[id]/refund — { paymentId, amount_minor, credit_note_id?, reason? } via the payment's provider. */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const scope = await requireScope({ area: "billing", edit: true });
    const body = await parseBody(req, RefundBodySchema, 8_000);
    if (!body.ok) return body.res;
    const out = await refundPayment(scope.dataId, await paramId(ctx), body.data);
    await recordAudit(scope, { action: "create", entity: "refund", entityId: await paramId(ctx), after: { amount_minor: body.data.amount_minor }, req });
    return NextResponse.json(out, { status: 201 });
  } catch (err) {
    return errorResponse(err, "invoices.id.refund");
  }
}
