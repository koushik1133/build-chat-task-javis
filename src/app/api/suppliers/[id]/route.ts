import { NextResponse, type NextRequest } from "next/server";
import { requireScope } from "@/lib/auth/scope";
import { paramId, parseBody } from "@/lib/money/http";
import { financeErrorResponse } from "@/lib/finance/http";
import { deleteSupplier, getSupplier, SupplierPatchSchema, updateSupplier } from "@/lib/procurement/suppliers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, ctx: Ctx) {
  try {
    const scope = await requireScope({ area: "billing" });
    const supplier = await getSupplier(scope.dataId, await paramId(ctx));
    if (!supplier) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ supplier });
  } catch (err) {
    return financeErrorResponse(err, "suppliers.id.GET");
  }
}

export async function PATCH(req: NextRequest, ctx: Ctx) {
  try {
    const scope = await requireScope({ area: "billing", edit: true });
    const body = await parseBody(req, SupplierPatchSchema);
    if (!body.ok) return body.res;
    const supplier = await updateSupplier(scope.dataId, await paramId(ctx), body.data);
    return NextResponse.json({ supplier });
  } catch (err) {
    return financeErrorResponse(err, "suppliers.id.PATCH");
  }
}

export async function DELETE(_req: NextRequest, ctx: Ctx) {
  try {
    const scope = await requireScope({ area: "billing", edit: true });
    const ok = await deleteSupplier(scope.dataId, await paramId(ctx));
    if (!ok) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return financeErrorResponse(err, "suppliers.id.DELETE");
  }
}
