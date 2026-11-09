import { NextResponse, type NextRequest } from "next/server";
import { requireScope } from "@/lib/auth/scope";
import { TaxRateInputSchema, createTaxRate, listTaxRates } from "@/lib/money/tax-rates";
import { errorResponse, parseBody } from "@/lib/money/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/tax-rates?all=1 — org tax catalogue (active only unless `all`). */
export async function GET(req: NextRequest) {
  try {
    const scope = await requireScope({ area: "billing" });
    const rates = await listTaxRates(scope.dataId, { includeInactive: req.nextUrl.searchParams.get("all") === "1" });
    return NextResponse.json({ rates });
  } catch (err) {
    return errorResponse(err, "tax-rates.GET");
  }
}

export async function POST(req: NextRequest) {
  try {
    const scope = await requireScope({ area: "billing", edit: true });
    const body = await parseBody(req, TaxRateInputSchema, 8_000);
    if (!body.ok) return body.res;
    const rate = await createTaxRate(scope.dataId, body.data);
    return NextResponse.json({ rate }, { status: 201 });
  } catch (err) {
    return errorResponse(err, "tax-rates.POST");
  }
}
