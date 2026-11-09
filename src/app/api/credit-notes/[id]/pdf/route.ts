import { NextResponse, type NextRequest } from "next/server";
import { requireScope } from "@/lib/auth/scope";
import { getCreditNote } from "@/lib/money/credit-notes";
import { errorResponse, paramId } from "@/lib/money/http";
import { buildCreditNotePdf, pdfResponse } from "@/lib/pdf/documents";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const scope = await requireScope({ area: "billing" });
    const note = await getCreditNote(scope.dataId, await paramId(ctx));
    if (!note) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const built = await buildCreditNotePdf(scope.dataId, note);
    return pdfResponse(built, req.nextUrl.searchParams.get("download") ? "attachment" : "inline");
  } catch (err) {
    return errorResponse(err, "credit-notes.id.pdf.GET");
  }
}
