import { NextResponse, type NextRequest } from "next/server";
import { requireScope } from "@/lib/auth/scope";
import { paramId, parseBody } from "@/lib/money/http";
import { financeErrorResponse } from "@/lib/finance/http";
import { getSupplierBill, listBillPayments, SupplierBillPatchSchema, updateSupplierBill } from "@/lib/procurement/bills";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, ctx: Ctx) {
  try {
    const scope = await requireScope({ area: "billing" });
    const bill = await getSupplierBill(scope.dataId, await paramId(ctx));
    if (!bill) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const payments = await listBillPayments(scope.dataId, bill.id);
    return NextResponse.json({ bill, payments });
  } catch (err) {
    return financeErrorResponse(err, "supplier-bills.id.GET");
  }
}

export async function PATCH(req: NextRequest, ctx: Ctx) {
  try {
    const scope = await requireScope({ area: "billing", edit: true });
    const body = await parseBody(req, SupplierBillPatchSchema, 256_000);
    if (!body.ok) return body.res;
    const bill = await updateSupplierBill(scope.dataId, await paramId(ctx), body.data);
    return NextResponse.json({ bill });
  } catch (err) {
    return financeErrorResponse(err, "supplier-bills.id.PATCH");
  }
}
