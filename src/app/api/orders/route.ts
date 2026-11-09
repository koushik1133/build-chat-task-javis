import { NextResponse, type NextRequest } from "next/server";
import { requireScope } from "@/lib/auth/scope";
import { errorResponse } from "@/lib/money/http";
import { normaliseCursor, page, parseListParams } from "@/lib/public-api/pagination";
import { listOrders, orderCounts } from "@/lib/storefront/orders";
import { isOrderStatus } from "@/lib/storefront/pure";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/orders?status=&q=&cursor=&limit= — keyset-paginated, newest first, plus per-status counts (always included, including on cursor pages). */
export async function GET(req: NextRequest) {
  try {
    const scope = await requireScope({ area: "billing", edit: false });
    const url = new URL(req.url);
    const list = parseListParams(url, { limit: 50 });
    if (list.badCursor) return NextResponse.json({ error: "invalid cursor" }, { status: 400 });
    const status = url.searchParams.get("status");
    if (status && !isOrderStatus(status)) return NextResponse.json({ error: "invalid status" }, { status: 400 });
    const [rows, counts] = await Promise.all([
      listOrders(scope.dataId, { status: isOrderStatus(status) ? status : null, q: list.q, cursor: list.cursor, limit: list.limit + 1 }),
      orderCounts(scope.dataId),
    ]);
    const pg = page(rows, list.limit, (r) => normaliseCursor(r));
    return NextResponse.json({ orders: pg.data, next_cursor: pg.next_cursor, counts });
  } catch (err) {
    return errorResponse(err, "orders.GET");
  }
}
