import { NextResponse, type NextRequest } from "next/server";
import { paramToken, publicRateLimit } from "@/lib/money/http";
import { publicDocumentForToken, SignLinkError } from "@/lib/documents/signing";

export const runtime = "nodejs";

/** GET /api/p/sign/[token] — the signer's view of the document (marks viewed). */
export async function GET(req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const limited = await publicRateLimit(req, "sign");
  if (limited) return limited;
  try {
    const document = await publicDocumentForToken(await paramToken(ctx));
    return NextResponse.json({ document });
  } catch (err) {
    if (err instanceof SignLinkError) return NextResponse.json({ error: err.code }, { status: err.code === "expired" ? 410 : 404 });
    console.error("[p.sign.GET]", err);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
