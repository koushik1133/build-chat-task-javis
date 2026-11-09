import { NextResponse, type NextRequest } from "next/server";
import { requireScope } from "@/lib/auth/scope";
import { errorResponse, parseBody } from "@/lib/money/http";
import { ProductTaxSchema, getProductTaxFields, setProductTaxFields } from "@/lib/tax-compliance/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET/PUT the tax-compliance fields of one product (kept separate from the core product routes). */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const scope = await requireScope({ area: "billing" });
    const { id } = await ctx.params;
    const fields = await getProductTaxFields(scope.dataId, id);
    return fields ? NextResponse.json({ fields }) : NextResponse.json({ error: "not_found" }, { status: 404 });
  } catch (err) {
    return errorResponse(err, "tax.product.GET");
  }
}

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const scope = await requireScope({ area: "billing", edit: true });
    const { id } = await ctx.params;
    const body = await parseBody(req, ProductTaxSchema, 4_000);
    if (!body.ok) return body.res;
    const ok = await setProductTaxFields(scope.dataId, id, body.data);
    return ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "not_found" }, { status: 404 });
  } catch (err) {
    return errorResponse(err, "tax.product.PUT");
  }
}
