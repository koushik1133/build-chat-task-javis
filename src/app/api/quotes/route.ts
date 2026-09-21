import { NextResponse, type NextRequest } from "next/server";
import { requireScope } from "@/lib/auth/scope";
import { createQuote, listQuotes } from "@/lib/money/quotes";
import { QuoteBodySchema, errorResponse, parseBody } from "@/lib/money/http";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  try {
    const scope = await requireScope({ area: "billing" });
    const status = req.nextUrl.searchParams.get("status") ?? undefined;
    const quotes = await listQuotes(scope.dataId, { status });
    return NextResponse.json({ quotes });
  } catch (err) {
    return errorResponse(err, "quotes.GET");
  }
}

export async function POST(req: NextRequest) {
  try {
    const scope = await requireScope({ area: "billing", edit: true });
    const body = await parseBody(req, QuoteBodySchema);
    if (!body.ok) return body.res;
    const quote = await createQuote(scope.dataId, { ...body.data, items: body.data.items ?? [] });
    return NextResponse.json({ quote }, { status: 201 });
  } catch (err) {
    return errorResponse(err, "quotes.POST");
  }
}
