import { NextResponse, type NextRequest } from "next/server";
import { requireScope } from "@/lib/auth/scope";
import { parseBody } from "@/lib/money/http";
import { financeErrorResponse } from "@/lib/finance/http";
import { rateLimitAsync } from "@/lib/request-limits";
import { createPurchaseOrder, listPurchaseOrders, PurchaseOrderInputSchema } from "@/lib/procurement/purchase-orders";
import { normaliseCursor, page, parseListParams } from "@/lib/public-api/pagination";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/purchase-orders?status=&supplier=&cursor=&limit= (keyset, newest first) */
export async function GET(req: NextRequest) {
  try {
    const scope = await requireScope({ area: "billing" });
    const sp = req.nextUrl.searchParams;
    const list = parseListParams(req.nextUrl, { limit: 50 });
    if (list.badCursor) return NextResponse.json({ error: "invalid cursor" }, { status: 400 });
    const rows = await listPurchaseOrders(scope.dataId, { status: sp.get("status"), supplierId: sp.get("supplier"), cursor: list.cursor, limit: list.limit + 1 });
    const pg = page(rows, list.limit, (r) => normaliseCursor({ created_at: r.created_at, id: r.id }));
    return NextResponse.json({ purchase_orders: pg.data, next_cursor: pg.next_cursor });
  } catch (err) {
    return financeErrorResponse(err, "purchase-orders.GET");
  }
}

export async function POST(req: NextRequest) {
  try {
    const scope = await requireScope({ area: "billing", edit: true });
    const rl = await rateLimitAsync(`po:create:${scope.dataId}`, 120, 60_000);
    if (!rl.allowed) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
    const body = await parseBody(req, PurchaseOrderInputSchema, 256_000);
    if (!body.ok) return body.res;
    const purchase_order = await createPurchaseOrder(scope.dataId, body.data, scope.userId);
    return NextResponse.json({ purchase_order }, { status: 201 });
  } catch (err) {
    return financeErrorResponse(err, "purchase-orders.POST");
  }
}
