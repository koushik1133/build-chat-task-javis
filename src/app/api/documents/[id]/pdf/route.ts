import { NextResponse, type NextRequest } from "next/server";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { errorResponse, paramId } from "@/lib/money/http";
import { getDocument, servePdf, SignedPdfIntegrityError } from "@/lib/documents/documents";
import { captureError } from "@/lib/errors/capture";
import { pdfResponse } from "@/lib/pdf/documents";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/documents/[id]/pdf — unsigned preview, or the stored hash-verified signed copy once fully signed. `?download=1` for attachment. */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  let scope;
  try {
    scope = await requireScope({ area: "crm" });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const doc = await getDocument(scope.dataId, await paramId(ctx));
    if (!doc) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const built = await servePdf(scope.dataId, doc);
    return pdfResponse(built, new URL(req.url).searchParams.get("download") ? "attachment" : "inline");
  } catch (err) {
    if (err instanceof SignedPdfIntegrityError) {
      void captureError(err, { route: "/api/documents/[id]/pdf", method: "GET", status: 500 });
      return NextResponse.json({ error: "integrity_check_failed", detail: "The stored signed PDF does not match its recorded hash." }, { status: 500 });
    }
    return errorResponse(err, "documents.id.pdf");
  }
}
