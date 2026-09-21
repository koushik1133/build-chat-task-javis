import { NextResponse, type NextRequest } from "next/server";
import { requireScope } from "@/lib/auth/scope";
import { voidInvoice } from "@/lib/money/invoices";
import { errorResponse, paramId } from "@/lib/money/http";

export const runtime = "nodejs";

export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const scope = await requireScope({ area: "billing", edit: true });
    const invoice = await voidInvoice(scope.dataId, await paramId(ctx));
    return NextResponse.json({ invoice });
  } catch (err) {
    return errorResponse(err, "invoices.void");
  }
}
