import { NextResponse, type NextRequest } from "next/server";
import { requireScope } from "@/lib/auth/scope";
import { createInvoice, listInvoices } from "@/lib/money/invoices";
import { describeProviders } from "@/lib/payments";
import { InvoiceBodySchema, errorResponse, parseBody } from "@/lib/money/http";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  try {
    const scope = await requireScope({ area: "billing" });
    const status = req.nextUrl.searchParams.get("status") ?? undefined;
    const invoices = await listInvoices(scope.dataId, { status });
    return NextResponse.json({ invoices, providers: describeProviders() });
  } catch (err) {
    return errorResponse(err, "invoices.GET");
  }
}

export async function POST(req: NextRequest) {
  try {
    const scope = await requireScope({ area: "billing", edit: true });
    const body = await parseBody(req, InvoiceBodySchema);
    if (!body.ok) return body.res;
    const invoice = await createInvoice(scope.dataId, { ...body.data, items: body.data.items ?? [] });
    return NextResponse.json({ invoice }, { status: 201 });
  } catch (err) {
    return errorResponse(err, "invoices.POST");
  }
}
