import { NextResponse, type NextRequest } from "next/server";
import { requireScope } from "@/lib/auth/scope";
import { getInvoice } from "@/lib/money/invoices";
import { errorResponse, paramId } from "@/lib/money/http";
import { buildInvoicePdf, pdfResponse } from "@/lib/pdf/documents";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const scope = await requireScope({ area: "billing" });
    const invoice = await getInvoice(scope.dataId, await paramId(ctx));
    if (!invoice) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const built = await buildInvoicePdf(scope.dataId, invoice);
    return pdfResponse(built, req.nextUrl.searchParams.get("download") ? "attachment" : "inline");
  } catch (err) {
    return errorResponse(err, "invoices.id.pdf.GET");
  }
}
