import { NextResponse, type NextRequest } from "next/server";
import { requireScope } from "@/lib/auth/scope";
import { paramId } from "@/lib/money/http";
import { financeErrorResponse } from "@/lib/finance/http";
import { cancelPurchaseOrder } from "@/lib/procurement/purchase-orders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const scope = await requireScope({ area: "billing", edit: true });
    const purchase_order = await cancelPurchaseOrder(scope.dataId, await paramId(ctx));
    return NextResponse.json({ purchase_order });
  } catch (err) {
    return financeErrorResponse(err, "purchase-orders.id.cancel.POST");
  }
}
