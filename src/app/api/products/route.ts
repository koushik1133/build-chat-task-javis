import { NextResponse, type NextRequest } from "next/server";
import { requireScope } from "@/lib/auth/scope";
import { parseBody } from "@/lib/money/http";
import { financeErrorResponse } from "@/lib/finance/http";
import { createProduct, listProducts, PRODUCT_KINDS, ProductInputSchema, type ProductKind } from "@/lib/inventory/products";
import { normaliseCursor, page, parseListParams } from "@/lib/public-api/pagination";

export const runtime = "nodejs";

/**
 * GET /api/products?q=&low=1&kind=&inactive=1[&order=created&cursor=&limit=]
 * Default: every product by name (legacy, `next_cursor: null`). With
 * `order=created` or a cursor the list is keyset-paginated newest first.
 */
export async function GET(req: NextRequest) {
  try {
    const scope = await requireScope({ area: "billing" });
    const sp = req.nextUrl.searchParams;
    const kind = sp.get("kind");
    const paged = sp.get("order") === "created" || sp.has("cursor");
    const list = parseListParams(req.nextUrl, { limit: 50 });
    if (paged && list.badCursor) return NextResponse.json({ error: "invalid cursor" }, { status: 400 });
    const rows = await listProducts(scope.dataId, {
      q: sp.get("q") ?? undefined,
      low: sp.get("low") === "1",
      kind: (PRODUCT_KINDS as readonly string[]).includes(kind ?? "") ? (kind as ProductKind) : undefined,
      includeInactive: sp.get("inactive") === "1",
      ...(paged ? { order: "created" as const, cursor: list.cursor, limit: list.limit + 1 } : {}),
    });
    if (!paged) return NextResponse.json({ products: rows, next_cursor: null });
    const pg = page(rows, list.limit, (r) => normaliseCursor({ created_at: r.created_at, id: r.id }));
    return NextResponse.json({ products: pg.data, next_cursor: pg.next_cursor });
  } catch (err) {
    return financeErrorResponse(err, "products.GET");
  }
}

export async function POST(req: NextRequest) {
  try {
    const scope = await requireScope({ area: "billing", edit: true });
    const body = await parseBody(req, ProductInputSchema);
    if (!body.ok) return body.res;
    const product = await createProduct(scope.dataId, body.data, scope.userId);
    return NextResponse.json({ product }, { status: 201 });
  } catch (err) {
    return financeErrorResponse(err, "products.POST");
  }
}
