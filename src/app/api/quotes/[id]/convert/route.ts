import { NextResponse, type NextRequest } from "next/server";
import { requireScope } from "@/lib/auth/scope";
import { createInvoiceFromQuote } from "@/lib/money/invoices";
import { errorResponse, paramId } from "@/lib/money/http";

export const runtime = "nodejs";

export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const scope = await requireScope({ area: "billing", edit: true });
    const invoice = await createInvoiceFromQuote(scope.dataId, await paramId(ctx));
    return NextResponse.json({ invoice }, { status: 201 });
  } catch (err) {
    return errorResponse(err, "quotes.convert");
  }
}
