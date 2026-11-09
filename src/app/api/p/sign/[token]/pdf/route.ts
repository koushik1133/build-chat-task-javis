import { NextResponse, type NextRequest } from "next/server";
import { paramToken, publicRateLimit } from "@/lib/money/http";
import { pdfForToken, SignLinkError } from "@/lib/documents/signing";
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
    console.error("[p.sign.pdf]", err);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
