import { NextResponse, type NextRequest } from "next/server";
import { resolveShareToken } from "@/lib/share-tokens";
import { buildStatement } from "@/lib/money/statements";
import { paramToken, publicRateLimit } from "@/lib/money/http";
import { buildStatementPdf, pdfResponse } from "@/lib/pdf/documents";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function range(params: URLSearchParams): { from: Date | null; to: Date | null } {
  const p = (k: string, tail: string): Date | null => {
    const v = params.get(k);
    if (!v) return null;
    const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T${tail}Z` : v);
    return Number.isNaN(d.getTime()) ? null : d;
  };
  return { from: p("from", "00:00:00"), to: p("to", "23:59:59.999") };
}

/** GET /api/p/portal/[token]/statement?format=pdf — the portal contact's own statement. */
export async function GET(req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const limited = await publicRateLimit(req, "portal-statement", 30);
  if (limited) return limited;
  try {
    const share = await resolveShareToken("portal", await paramToken(ctx));
    if (!share) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const statement = await buildStatement(share.user_id, share.entity_id, range(req.nextUrl.searchParams));
    if (!statement) return NextResponse.json({ error: "not_found" }, { status: 404 });
    if (req.nextUrl.searchParams.get("format") === "pdf") {
      return pdfResponse(await buildStatementPdf(share.user_id, statement), "inline");
    }
    return NextResponse.json({ statement });
  } catch (err) {
    console.error("[p.portal.statement]", err);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
