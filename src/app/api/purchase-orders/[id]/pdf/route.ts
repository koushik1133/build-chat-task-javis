import { NextResponse, type NextRequest } from "next/server";
import { requireScope } from "@/lib/auth/scope";
import { errorResponse, paramId } from "@/lib/money/http";
import { getPurchaseOrder } from "@/lib/procurement/purchase-orders";
import { buildPurchaseOrderPdf, pdfResponse } from "@/lib/pdf/documents";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const scope = await requireScope({ area: "billing" });
    const po = await getPurchaseOrder(scope.dataId, await paramId(ctx));
    if (!po) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const built = await buildPurchaseOrderPdf(scope.dataId, po);
    return pdfResponse(built, req.nextUrl.searchParams.get("download") ? "attachment" : "inline");
  } catch (err) {
    return errorResponse(err, "purchase-orders.id.pdf.GET");
  }
}
