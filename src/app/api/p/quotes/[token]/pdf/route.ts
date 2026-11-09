import { NextResponse, type NextRequest } from "next/server";
import { resolveShareToken } from "@/lib/share-tokens";
import { getQuoteById } from "@/lib/money/quotes";
import { paramToken, publicRateLimit } from "@/lib/money/http";
import { buildQuotePdf, pdfResponse } from "@/lib/pdf/documents";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Public quote PDF behind the share token. After acceptance the stamped (signed) version is returned. */
export async function GET(req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const limited = await publicRateLimit(req, "quote-pdf", 30);
  if (limited) return limited;
  try {
    const share = await resolveShareToken("quote", await paramToken(ctx));
    if (!share) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const quote = await getQuoteById(share.entity_id);
    if (!quote) return NextResponse.json({ error: "not_found" }, { status: 404 });
    // Public copy: the signer's raw IP / user agent stay on the authenticated PDF only.
    const built = await buildQuotePdf(share.user_id, quote, { redactEvidence: true });
    return pdfResponse(built, req.nextUrl.searchParams.get("download") ? "attachment" : "inline");
  } catch (err) {
    console.error("[p.quotes.pdf]", err);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
