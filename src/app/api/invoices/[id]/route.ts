import { NextResponse, type NextRequest } from "next/server";
import { requireScope } from "@/lib/auth/scope";
import { getInvoice, listPayments, updateInvoice } from "@/lib/money/invoices";
import { InvoiceBodySchema, errorResponse, paramId, parseBody } from "@/lib/money/http";

export const runtime = "nodejs";
type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, ctx: Ctx) {
  try {
    const scope = await requireScope({ area: "billing" });
    const invoice = await getInvoice(scope.dataId, await paramId(ctx));
    if (!invoice) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const payments = await listPayments(invoice.id);
    return NextResponse.json({ invoice, payments });
  } catch (err) {
    return errorResponse(err, "invoices.id.GET");
  }
}

export async function PATCH(req: NextRequest, ctx: Ctx) {
  try {
    const scope = await requireScope({ area: "billing", edit: true });
    const body = await parseBody(req, InvoiceBodySchema);
    if (!body.ok) return body.res;
    const invoice = await updateInvoice(scope.dataId, await paramId(ctx), body.data);
    return NextResponse.json({ invoice });
  } catch (err) {
    return errorResponse(err, "invoices.id.PATCH");
  }
}
