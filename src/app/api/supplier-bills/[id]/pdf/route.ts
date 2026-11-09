import { NextResponse, type NextRequest } from "next/server";
import { requireScope } from "@/lib/auth/scope";
import { errorResponse, paramId } from "@/lib/money/http";
import { getSupplierBill } from "@/lib/procurement/bills";
import { buildSupplierBillPdf, pdfResponse } from "@/lib/pdf/documents";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const scope = await requireScope({ area: "billing" });
    const bill = await getSupplierBill(scope.dataId, await paramId(ctx));
    if (!bill) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const built = await buildSupplierBillPdf(scope.dataId, bill);
    return pdfResponse(built, req.nextUrl.searchParams.get("download") ? "attachment" : "inline");
  } catch (err) {
    return errorResponse(err, "supplier-bills.id.pdf.GET");
  }
}
