import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { findUsableCard, giftCardAttemptAllowed } from "@/lib/engagement/giftcards";
import { NO_STORE, clientIp, notFound, resolveShop, shopRateLimit } from "@/lib/storefront/http";
import { readCappedText } from "@/lib/request-limits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({ code: z.string().trim().min(1).max(40) }).strict();

/** POST /api/shop/[org]/gift-card/balance { code } -> { balance_minor, currency }. Generic errors; 5/min and 20/day per IP + code prefix. */
export async function POST(req: NextRequest, ctx: { params: Promise<{ org: string }> }) {
  const block = await shopRateLimit(req, "giftbal", 30);
  if (block) return block;
  const pub = await resolveShop(ctx);
  if (!pub) return notFound();
  const text = await readCappedText(req, 1024);
  let json: unknown = null;
  try { json = JSON.parse(text || "null"); } catch { /* handled below */ }
  const parsed = Body.safeParse(json);
  if (!parsed.success) return NextResponse.json({ error: "invalid_body" }, { status: 400, headers: NO_STORE });
  if (!(await giftCardAttemptAllowed(clientIp(req)))) return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: NO_STORE });
  const card = await findUsableCard(pub.dataId, parsed.data.code).catch(() => null);
  if (!card) return NextResponse.json({ error: "invalid_code", detail: "That gift card could not be found." }, { status: 404, headers: NO_STORE });
  return NextResponse.json({ balance_minor: card.balance_minor, currency: card.currency, last4: card.code_last4 }, { headers: NO_STORE });
}
