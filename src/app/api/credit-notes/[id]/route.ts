import { NextResponse, type NextRequest } from "next/server";
import { requireScope } from "@/lib/auth/scope";
import { deleteDraftCreditNote, getCreditNote } from "@/lib/money/credit-notes";
import { errorResponse, paramId } from "@/lib/money/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, ctx: Ctx) {
  try {
    const scope = await requireScope({ area: "billing" });
    const credit_note = await getCreditNote(scope.dataId, await paramId(ctx));
    if (!credit_note) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ credit_note });
  } catch (err) {
    return errorResponse(err, "credit-notes.id.GET");
  }
}

export async function DELETE(_req: NextRequest, ctx: Ctx) {
  try {
    const scope = await requireScope({ area: "billing", edit: true });
    const ok = await deleteDraftCreditNote(scope.dataId, await paramId(ctx));
    if (!ok) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err, "credit-notes.id.DELETE");
  }
}
