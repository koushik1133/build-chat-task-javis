import { NextResponse, type NextRequest } from "next/server";
import { resolveShareToken } from "@/lib/share-tokens";
import { getInvoiceById } from "@/lib/money/invoices";
import { paramToken, publicRateLimit } from "@/lib/money/http";
import { buildInvoicePdf, pdfResponse } from "@/lib/pdf/documents";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const limited = publicRateLimit(req, "invoice-pdf", 30);
  if (limited) return limited;
  try {
    const share = await resolveShareToken("invoice", await paramToken(ctx));
    if (!share) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const invoice = await getInvoiceById(share.entity_id);
    if (!invoice) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const built = await buildInvoicePdf(share.user_id, invoice);
    return pdfResponse(built, req.nextUrl.searchParams.get("download") ? "attachment" : "inline");
  } catch (err) {
    console.error("[p.invoices.pdf]", err);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
