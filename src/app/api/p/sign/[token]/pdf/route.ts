import { NextResponse, type NextRequest } from "next/server";
import { paramToken, publicRateLimit } from "@/lib/money/http";
import { pdfForToken, SignLinkError } from "@/lib/documents/signing";
import { DocumentError, SignedPdfIntegrityError } from "@/lib/documents/documents";
import { captureError } from "@/lib/errors/capture";
import { pdfResponse } from "@/lib/pdf/documents";

export const runtime = "nodejs";

/** GET /api/p/sign/[token]/pdf — the document PDF for a signer (evidence redacted on the signed copy). */
export async function GET(req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const limited = await publicRateLimit(req, "sign-pdf", 30);
  if (limited) return limited;
  try {
    const built = await pdfForToken(await paramToken(ctx));
    return pdfResponse(built, "attachment");
  } catch (err) {
    if (err instanceof SignLinkError) return NextResponse.json({ error: err.code }, { status: err.code === "expired" ? 410 : 404 });
    if (err instanceof DocumentError) return NextResponse.json({ error: "unavailable", detail: err.message }, { status: 410 });
    if (err instanceof SignedPdfIntegrityError) {
      void captureError(err, { route: "/api/p/sign/[token]/pdf", method: "GET", status: 500 });
      return NextResponse.json({ error: "integrity_check_failed" }, { status: 500 });
    }
    console.error("[p.sign.pdf]", err);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
