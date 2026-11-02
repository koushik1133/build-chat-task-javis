import { NextResponse, type NextRequest } from "next/server";
import { requireScope } from "@/lib/auth/scope";
import { parseBody } from "@/lib/money/http";
import { financeErrorResponse } from "@/lib/finance/http";
import { createProduct, listProducts, PRODUCT_KINDS, ProductInputSchema, type ProductKind } from "@/lib/inventory/products";

export const runtime = "nodejs";

/** GET /api/products?q=&low=1&kind=&inactive=1 */
export async function GET(req: NextRequest) {
  try {
    const scope = await requireScope({ area: "billing" });
    const sp = req.nextUrl.searchParams;
    const kind = sp.get("kind");
    const products = await listProducts(scope.dataId, {
      q: sp.get("q") ?? undefined,
      low: sp.get("low") === "1",
      kind: (PRODUCT_KINDS as readonly string[]).includes(kind ?? "") ? (kind as ProductKind) : undefined,
      includeInactive: sp.get("inactive") === "1",
    });
    return NextResponse.json({ products });
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
