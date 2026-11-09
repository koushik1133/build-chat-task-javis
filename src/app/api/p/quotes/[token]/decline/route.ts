import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { resolveShareToken } from "@/lib/share-tokens";
import { declineQuoteVerified } from "@/lib/money/acceptance";
import { toPublicQuote } from "@/lib/money/public";
import { paramToken, parseBody, publicRateLimit } from "@/lib/money/http";

export const runtime = "nodejs";

const Body = z
  .object({
    otp: z.string().trim().regex(/^\d{6}$/, "6-digit code expected"),
    email: z.string().trim().email().max(200),
    reason: z.string().trim().max(2000).optional(),
  })
  .strict();

/**
 * Client-side decline from the public quote page. Requires the same email OTP
 * gate as acceptance (request one via POST ../otp with purpose "decline"), so
 * link possession alone cannot decline a quote.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const limited = await publicRateLimit(req, "quote-decline", 20);
  if (limited) return limited;
  try {
    const share = await resolveShareToken("quote", await paramToken(ctx));
    if (!share) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const body = await parseBody(req, Body, 8_192);
    if (!body.ok) return body.res;
    const out = await declineQuoteVerified(share.entity_id, { otp: body.data.otp, email: body.data.email, reason: body.data.reason ?? null });
    return NextResponse.json({ quote: await toPublicQuote(out.quote, share.user_id, false) });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "error";
    if (err instanceof Error && err.name !== "DbError") return NextResponse.json({ error: "bad_request", detail: msg }, { status: 400 });
    console.error("[p.quotes.decline]", err);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
