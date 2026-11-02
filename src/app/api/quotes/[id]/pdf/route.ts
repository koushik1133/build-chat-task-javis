import { NextResponse, type NextRequest } from "next/server";
import { requireScope } from "@/lib/auth/scope";
import { getQuote } from "@/lib/money/quotes";
import { errorResponse, paramId } from "@/lib/money/http";
import { buildQuotePdf, pdfResponse } from "@/lib/pdf/documents";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Quote PDF for the owning org; stamped with the signature block once accepted. `?download=1` forces attachment. */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const scope = await requireScope({ area: "billing" });
    const quote = await getQuote(scope.dataId, await paramId(ctx));
    if (!quote) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const built = await buildQuotePdf(scope.dataId, quote);
    return pdfResponse(built, req.nextUrl.searchParams.get("download") ? "attachment" : "inline");
  } catch (err) {
    return errorResponse(err, "quotes.id.pdf.GET");
  }
}
