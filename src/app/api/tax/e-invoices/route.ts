import { NextResponse } from "next/server";
import { requireScope } from "@/lib/auth/scope";
import { errorResponse } from "@/lib/money/http";
import { listEInvoices } from "@/lib/tax-compliance/einvoice/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const scope = await requireScope({ area: "billing" });
    return NextResponse.json({ e_invoices: await listEInvoices(scope.dataId) });
  } catch (err) {
    return errorResponse(err, "tax.einvoices.GET");
  }
}
