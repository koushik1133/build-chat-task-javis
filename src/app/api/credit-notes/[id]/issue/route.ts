import { NextResponse, type NextRequest } from "next/server";
import { requireScope } from "@/lib/auth/scope";
import { issueCreditNote } from "@/lib/money/credit-notes";
import { errorResponse, paramId } from "@/lib/money/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/credit-notes/[id]/issue — draft → issued/applied, emits credit_note.issued. */
export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const scope = await requireScope({ area: "billing", edit: true });
    const credit_note = await issueCreditNote(scope.dataId, await paramId(ctx));
    return NextResponse.json({ credit_note });
  } catch (err) {
    return errorResponse(err, "credit-notes.id.issue");
  }
}
