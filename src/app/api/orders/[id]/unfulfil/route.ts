import { NextResponse, type NextRequest } from "next/server";
import { requireScope } from "@/lib/auth/scope";
import { errorResponse, paramId } from "@/lib/money/http";
import { recordAudit } from "@/lib/audit";
import { unfulfillOrder } from "@/lib/storefront/orders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** POST /api/orders/[id]/unfulfil — fulfilled → paid (undo a mistaken fulfilment). Emits `order.unfulfilled`. */
export async function POST(_req: NextRequest, ctx: Ctx) {
  try {
    const scope = await requireScope({ area: "billing", edit: true });
    const id = await paramId(ctx);
    const order = await unfulfillOrder(scope.dataId, id, scope.userId);
    void recordAudit({ dataId: scope.dataId, userId: scope.userId }, { action: "order.unfulfilled", entity: "order", entityId: id, after: { number: order.number } });
    return NextResponse.json({ order });
  } catch (err) {
    return errorResponse(err, "orders.id.unfulfil.POST");
  }
}
