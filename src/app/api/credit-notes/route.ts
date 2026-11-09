import { NextResponse, type NextRequest } from "next/server";
import { requireScope } from "@/lib/auth/scope";
import { CreditNoteInputSchema, createCreditNote, listCreditNotes } from "@/lib/money/credit-notes";
import { errorResponse, parseBody } from "@/lib/money/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const scope = await requireScope({ area: "billing" });
    const q = req.nextUrl.searchParams;
    const notes = await listCreditNotes(scope.dataId, {
      status: q.get("status") ?? undefined,
      invoice_id: q.get("invoice_id") ?? undefined,
      contact_id: q.get("contact_id") ?? undefined,
    });
    return NextResponse.json({ credit_notes: notes });
  } catch (err) {
    return errorResponse(err, "credit-notes.GET");
  }
}

/** POST — draft (or `issue: true` to issue immediately). Omit `items` to credit the whole invoice. */
export async function POST(req: NextRequest) {
  try {
    const scope = await requireScope({ area: "billing", edit: true });
    const body = await parseBody(req, CreditNoteInputSchema);
    if (!body.ok) return body.res;
    const credit_note = await createCreditNote(scope.dataId, body.data);
    return NextResponse.json({ credit_note }, { status: 201 });
  } catch (err) {
    return errorResponse(err, "credit-notes.POST");
  }
}
