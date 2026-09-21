import { NextResponse, type NextRequest } from "next/server";
import { requireScope } from "@/lib/auth/scope";
import { deleteDraftQuote, getQuote, updateQuote } from "@/lib/money/quotes";
import { QuoteBodySchema, errorResponse, paramId, parseBody } from "@/lib/money/http";

export const runtime = "nodejs";
type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, ctx: Ctx) {
  try {
    const scope = await requireScope({ area: "billing" });
    const quote = await getQuote(scope.dataId, await paramId(ctx));
    if (!quote) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ quote });
  } catch (err) {
    return errorResponse(err, "quotes.id.GET");
  }
}

export async function PATCH(req: NextRequest, ctx: Ctx) {
  try {
    const scope = await requireScope({ area: "billing", edit: true });
    const body = await parseBody(req, QuoteBodySchema);
    if (!body.ok) return body.res;
    const quote = await updateQuote(scope.dataId, await paramId(ctx), body.data);
    return NextResponse.json({ quote });
  } catch (err) {
    return errorResponse(err, "quotes.id.PATCH");
  }
}

export async function DELETE(_req: NextRequest, ctx: Ctx) {
  try {
    const scope = await requireScope({ area: "billing", edit: true });
    const ok = await deleteDraftQuote(scope.dataId, await paramId(ctx));
    if (!ok) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err, "quotes.id.DELETE");
  }
}
