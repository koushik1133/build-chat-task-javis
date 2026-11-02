import { NextResponse, type NextRequest } from "next/server";
import { requireScope } from "@/lib/auth/scope";
import { paramId, parseBody } from "@/lib/money/http";
import { financeErrorResponse } from "@/lib/finance/http";
import { deleteProduct, getProduct, ProductPatchSchema, updateProduct } from "@/lib/inventory/products";
import { listMovements } from "@/lib/inventory/stock";

export const runtime = "nodejs";
type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, ctx: Ctx) {
  try {
    const scope = await requireScope({ area: "billing" });
    const product = await getProduct(scope.dataId, await paramId(ctx));
    if (!product) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const movements = await listMovements(scope.dataId, product.id, 50);
    return NextResponse.json({ product, movements });
  } catch (err) {
    return financeErrorResponse(err, "products.id.GET");
  }
}

export async function PATCH(req: NextRequest, ctx: Ctx) {
  try {
    const scope = await requireScope({ area: "billing", edit: true });
    const body = await parseBody(req, ProductPatchSchema);
    if (!body.ok) return body.res;
    const product = await updateProduct(scope.dataId, await paramId(ctx), body.data);
    return NextResponse.json({ product });
  } catch (err) {
    return financeErrorResponse(err, "products.id.PATCH");
  }
}

export async function DELETE(_req: NextRequest, ctx: Ctx) {
  try {
    const scope = await requireScope({ area: "billing", edit: true });
    const ok = await deleteProduct(scope.dataId, await paramId(ctx));
    if (!ok) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return financeErrorResponse(err, "products.id.DELETE");
  }
}
