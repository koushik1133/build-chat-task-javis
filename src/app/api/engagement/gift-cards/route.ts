import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { recordAudit } from "@/lib/audit";
import { body, engScope, fail, gate, isResponse, limitParam, writeLimit } from "@/lib/engagement/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
import { issueGiftCard, listGiftCards } from "@/lib/engagement/giftcards";

export async function GET(req: NextRequest) {
  const scope = await engScope("billing", false);
  if (isResponse(scope)) return scope;
  try {
    return NextResponse.json({ gift_cards: await listGiftCards(scope.dataId, { status: req.nextUrl.searchParams.get("status"), limit: limitParam(req) }) });
  } catch (err) {
    return fail(err, "engagement.giftcards.GET");
  }
}

const Issue = z
  .object({
    amount_minor: z.number().int().min(1).max(100_000_000),
    currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/),
    recipient_email: z.string().trim().email().max(200).nullable().optional(),
    purchaser_contact_id: z.string().max(100).nullable().optional(),
    message: z.string().trim().max(500).nullable().optional(),
    expires_at: z.string().datetime({ offset: true }).nullable().optional(),
  })
  .strict();

/** POST → 201 { gift_card, code }. The code is returned ONCE and never stored. */
export async function POST(req: NextRequest) {
  const scope = await engScope("billing", true);
  if (isResponse(scope)) return scope;
  const limited = await writeLimit(scope, "giftcards", 30);
  if (limited) return limited;
  const blocked = await gate(scope, "gift_cards");
  if (blocked) return blocked;
  const b = await body(req, Issue);
  if (!b.ok) return b.res;
  try {
    const { card, code } = await issueGiftCard(scope.dataId, { amountMinor: b.data.amount_minor, currency: b.data.currency, recipientEmail: b.data.recipient_email, purchaserContactId: b.data.purchaser_contact_id, message: b.data.message, expiresAt: b.data.expires_at, issuedVia: "manual" });
    await recordAudit(scope, { action: "gift_card.issue", entity: "gift_card", entityId: card.id, after: { amount_minor: card.initial_minor, currency: card.currency, last4: card.code_last4 } });
    return NextResponse.json({ gift_card: card, code }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return fail(err, "engagement.giftcards.POST");
  }
}
