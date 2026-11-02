import { NextResponse, type NextRequest } from "next/server";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { dbUnavailableResponse } from "@/lib/api-db";
import { getQuote } from "@/lib/money/quotes";
import { paramId } from "@/lib/money/http";
import { runPricing } from "@/lib/optimize";
import { respondWithNarrative, wantsNarrative } from "@/lib/optimize/http";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/** GET /api/quotes/:id/pricing-suggestion?narrate=1 — pricing suggestion for the quote's current line items. */
export async function GET(req: NextRequest, ctx: Ctx) {
  let scope;
  try {
    scope = await requireScope({ area: "billing" });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const quote = await getQuote(scope.dataId, await paramId(ctx));
    if (!quote) return NextResponse.json({ error: "not_found" }, { status: 404 });
    if (quote.items.length === 0) return NextResponse.json({ error: "bad_request", detail: "The quote has no line items yet." }, { status: 400 });
    const suggestion = await runPricing(scope.dataId, quote.items.map((i) => ({ description: i.description, qty: i.qty, unit_minor: i.unit_minor })));
    const res = await respondWithNarrative(scope.dataId, "pricing", "suggestion", suggestion, wantsNarrative(req.nextUrl.searchParams));
    return res;
  } catch (err) {
    return dbUnavailableResponse(err, "quotes/pricing-suggestion");
  }
}
