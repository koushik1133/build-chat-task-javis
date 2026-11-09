import { NextResponse, type NextRequest } from "next/server";
import { requireScope } from "@/lib/auth/scope";
import { parseBody } from "@/lib/money/http";
import { financeErrorResponse } from "@/lib/finance/http";
import { rateLimitAsync } from "@/lib/request-limits";
import { createSupplier, listSuppliers, SupplierInputSchema } from "@/lib/procurement/suppliers";
import { normaliseCursor, page, parseListParams } from "@/lib/public-api/pagination";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/suppliers?q=&inactive=1[&order=created&cursor=&limit=] */
export async function GET(req: NextRequest) {
  try {
    const scope = await requireScope({ area: "billing" });
    const sp = req.nextUrl.searchParams;
    const paged = sp.get("order") === "created" || sp.has("cursor");
    const list = parseListParams(req.nextUrl, { limit: 50 });
    if (paged && list.badCursor) return NextResponse.json({ error: "invalid cursor" }, { status: 400 });
    const rows = await listSuppliers(scope.dataId, {
      q: sp.get("q"),
      includeInactive: sp.get("inactive") === "1",
      ...(paged ? { order: "created" as const, cursor: list.cursor, limit: list.limit + 1 } : { limit: 500 }),
    });
    if (!paged) return NextResponse.json({ suppliers: rows, next_cursor: null });
    const pg = page(rows, list.limit, (r) => normaliseCursor({ created_at: r.created_at, id: r.id }));
    return NextResponse.json({ suppliers: pg.data, next_cursor: pg.next_cursor });
  } catch (err) {
    return financeErrorResponse(err, "suppliers.GET");
  }
}

export async function POST(req: NextRequest) {
  try {
    const scope = await requireScope({ area: "billing", edit: true });
    const rl = await rateLimitAsync(`suppliers:create:${scope.dataId}`, 120, 60_000);
    if (!rl.allowed) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
    const body = await parseBody(req, SupplierInputSchema);
    if (!body.ok) return body.res;
    const supplier = await createSupplier(scope.dataId, body.data);
    return NextResponse.json({ supplier }, { status: 201 });
  } catch (err) {
    return financeErrorResponse(err, "suppliers.POST");
  }
}
