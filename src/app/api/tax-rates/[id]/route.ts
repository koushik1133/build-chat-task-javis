import { NextResponse, type NextRequest } from "next/server";
import { requireScope } from "@/lib/auth/scope";
import { TaxRatePatchSchema, deleteTaxRate, getTaxRate, updateTaxRate } from "@/lib/money/tax-rates";
import { errorResponse, paramId, parseBody } from "@/lib/money/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, ctx: Ctx) {
  try {
    const scope = await requireScope({ area: "billing" });
    const rate = await getTaxRate(scope.dataId, await paramId(ctx));
    if (!rate) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ rate });
  } catch (err) {
    return errorResponse(err, "tax-rates.id.GET");
  }
}

export async function PATCH(req: NextRequest, ctx: Ctx) {
  try {
    const scope = await requireScope({ area: "billing", edit: true });
    const body = await parseBody(req, TaxRatePatchSchema, 8_000);
    if (!body.ok) return body.res;
    const rate = await updateTaxRate(scope.dataId, await paramId(ctx), body.data);
    return NextResponse.json({ rate });
  } catch (err) {
    return errorResponse(err, "tax-rates.id.PATCH");
  }
}

/** Deactivates (documents keep resolving the rate). */
export async function DELETE(_req: NextRequest, ctx: Ctx) {
  try {
    const scope = await requireScope({ area: "billing", edit: true });
    const ok = await deleteTaxRate(scope.dataId, await paramId(ctx));
    if (!ok) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err, "tax-rates.id.DELETE");
  }
}
