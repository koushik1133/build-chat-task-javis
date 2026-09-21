import { NextResponse, type NextRequest } from "next/server";
import { resolveShareToken } from "@/lib/share-tokens";
import { getQuoteById, markQuoteViewed, quoteIsExpired } from "@/lib/money/quotes";
import { toPublicQuote } from "@/lib/money/public";
import { paramToken, publicRateLimit } from "@/lib/money/http";

export const runtime = "nodejs";

export async function GET(req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const limited = publicRateLimit(req, "quote");
  if (limited) return limited;
  try {
    const share = await resolveShareToken("quote", await paramToken(ctx));
    if (!share) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const q = await getQuoteById(share.entity_id);
    if (!q) return NextResponse.json({ error: "not_found" }, { status: 404 });
    if (q.status === "sent") {
      await markQuoteViewed(q.id);
      q.status = "viewed";
    }
    return NextResponse.json({ quote: await toPublicQuote(q, share.user_id, quoteIsExpired(q)) });
  } catch (err) {
    console.error("[p.quotes.GET]", err);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
