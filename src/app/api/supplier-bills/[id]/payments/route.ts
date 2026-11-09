import { NextResponse, type NextRequest } from "next/server";
import { requireScope } from "@/lib/auth/scope";
import { paramId, parseBody } from "@/lib/money/http";
import { financeErrorResponse } from "@/lib/finance/http";
import { rateLimitAsync } from "@/lib/request-limits";
import { BillPaymentInputSchema, getSupplierBill, listBillPayments, recordBillPayment } from "@/lib/procurement/bills";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, ctx: Ctx) {
  try {
    const scope = await requireScope({ area: "billing" });
    const id = await paramId(ctx);
    if (!(await getSupplierBill(scope.dataId, id))) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ payments: await listBillPayments(scope.dataId, id) });
  } catch (err) {
    return financeErrorResponse(err, "supplier-bills.id.payments.GET");
  }
}

export async function POST(req: NextRequest, ctx: Ctx) {
  try {
    const scope = await requireScope({ area: "billing", edit: true });
    const rl = await rateLimitAsync(`bills:pay:${scope.dataId}`, 120, 60_000);
    if (!rl.allowed) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
    const body = await parseBody(req, BillPaymentInputSchema);
    if (!body.ok) return body.res;
    const out = await recordBillPayment(scope.dataId, await paramId(ctx), body.data, scope.userId);
    return NextResponse.json(out, { status: 201 });
  } catch (err) {
    return financeErrorResponse(err, "supplier-bills.id.payments.POST");
  }
}
