import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { resolveShareToken } from "@/lib/share-tokens";
import { acceptQuote } from "@/lib/money/acceptance";
import { toPublicQuote } from "@/lib/money/public";
import { clientIp, paramToken, parseBody, publicRateLimit } from "@/lib/money/http";

export const runtime = "nodejs";

const Body = z.object({
  otp: z.string().trim().regex(/^\d{6}$/, "6-digit code expected"),
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().email().max(200),
  /** Typed e-signature; defaults to `name` when omitted. */
  signature_text: z.string().trim().min(1).max(200).optional(),
  accept_terms: z.literal(true).optional(),
});

export async function POST(req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const limited = publicRateLimit(req, "quote-accept", 30);
  if (limited) return limited;
  try {
    const share = await resolveShareToken("quote", await paramToken(ctx));
    if (!share) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const body = await parseBody(req, Body, 4_096);
    if (!body.ok) return body.res;
    const out = await acceptQuote(share.entity_id, {
      otp: body.data.otp,
      name: body.data.name,
      email: body.data.email,
      ip: clientIp(req),
      userAgent: req.headers.get("user-agent"),
      signatureText: body.data.signature_text ?? body.data.name,
    });
    return NextResponse.json({ quote: await toPublicQuote(out.quote, share.user_id, false), invoiceCreated: Boolean(out.invoiceId) });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "error";
    if (err instanceof Error && err.name !== "DbError") return NextResponse.json({ error: "bad_request", detail: msg }, { status: 400 });
    console.error("[p.quotes.accept]", err);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
