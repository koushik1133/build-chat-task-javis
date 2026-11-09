import { NextResponse, type NextRequest } from "next/server";
import { requireScope } from "@/lib/auth/scope";
import { errorResponse, parseBody } from "@/lib/money/http";
import { listStorefrontProducts, StorefrontProductPatchSchema, upsertStorefrontProduct } from "@/lib/storefront/catalog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/storefront/products — every active product with its storefront flags. */
export async function GET() {
  try {
    const scope = await requireScope({ area: "billing", edit: false });
    return NextResponse.json({ products: await listStorefrontProducts(scope.dataId) });
  } catch (err) {
    return errorResponse(err, "storefront.products.GET");
  }
}

/** PUT /api/storefront/products — { product_id, visible?, sort?, description_md?, image_url? } upsert. */
export async function PUT(req: NextRequest) {
  try {
    const scope = await requireScope({ area: "billing", edit: true });
    const body = await parseBody(req, StorefrontProductPatchSchema, 32_000);
    if (!body.ok) return body.res;
    return NextResponse.json({ product: await upsertStorefrontProduct(scope.dataId, body.data) });
  } catch (err) {
    return errorResponse(err, "storefront.products.PUT");
  }
}
