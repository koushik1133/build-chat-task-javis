import { NextResponse, type NextRequest } from "next/server";
import { requireScope } from "@/lib/auth/scope";
import { parseBody } from "@/lib/money/http";
import { financeErrorResponse } from "@/lib/finance/http";
import { ChangeOrderInputSchema, createChangeOrder, listChangeOrders } from "@/lib/finance/change-orders";

export const runtime = "nodejs";

/** GET /api/change-orders?quote_id=&invoice_id=&status= */
export async function GET(req: NextRequest) {
  try {
    const scope = await requireScope({ area: "billing" });
    const sp = req.nextUrl.searchParams;
    const change_orders = await listChangeOrders(scope.dataId, {
      quoteId: sp.get("quote_id"),
      invoiceId: sp.get("invoice_id"),
      status: sp.get("status"),
    });
    return NextResponse.json({ change_orders });
  } catch (err) {
    return financeErrorResponse(err, "change-orders.GET");
  }
}

export async function POST(req: NextRequest) {
  try {
    const scope = await requireScope({ area: "billing", edit: true });
    const body = await parseBody(req, ChangeOrderInputSchema);
    if (!body.ok) return body.res;
    const change_order = await createChangeOrder(scope.dataId, body.data);
    return NextResponse.json({ change_order }, { status: 201 });
  } catch (err) {
    return financeErrorResponse(err, "change-orders.POST");
  }
}
