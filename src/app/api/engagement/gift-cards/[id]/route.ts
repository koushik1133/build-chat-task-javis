import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { recordAudit } from "@/lib/audit";
import { body, engScope, fail, isResponse, writeLimit } from "@/lib/engagement/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
import { getGiftCard, giftCardLedger, voidGiftCard } from "@/lib/engagement/giftcards";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, ctx: Ctx) {
  const scope = await engScope("billing", false);
  if (isResponse(scope)) return scope;
  const id = (await ctx.params).id;
  const card = await getGiftCard(scope.dataId, id);
  return card ? NextResponse.json({ gift_card: card, ledger: await giftCardLedger(scope.dataId, id) }) : NextResponse.json({ error: "not_found" }, { status: 404 });
}

export async function PATCH(req: NextRequest, ctx: Ctx) {
  const scope = await engScope("billing", true);
  if (isResponse(scope)) return scope;
  const limited = await writeLimit(scope, "giftcards", 30);
  if (limited) return limited;
  const b = await body(req, z.object({ status: z.literal("void") }).strict());
  if (!b.ok) return b.res;
  try {
    const id = (await ctx.params).id;
    const card = await voidGiftCard(scope.dataId, id);
    await recordAudit(scope, { action: "gift_card.void", entity: "gift_card", entityId: id, after: { last4: card.code_last4, balance_minor: card.balance_minor } });
    return NextResponse.json({ gift_card: card });
  } catch (err) {
    return fail(err, "engagement.giftcards.PATCH");
  }
}
