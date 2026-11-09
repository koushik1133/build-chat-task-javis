import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { recordAudit } from "@/lib/audit";
import { body, engScope, fail, isResponse, writeLimit } from "@/lib/engagement/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
import { adjustGiftCard } from "@/lib/engagement/giftcards";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const scope = await engScope("billing", true);
  if (isResponse(scope)) return scope;
  const limited = await writeLimit(scope, "giftcards-adjust", 20);
  if (limited) return limited;
  const b = await body(req, z.object({ amount_minor: z.number().int().min(-100_000_000).max(100_000_000), note: z.string().trim().max(200).optional() }).strict());
  if (!b.ok) return b.res;
  try {
    const id = (await ctx.params).id;
    const res = await adjustGiftCard(scope.dataId, id, b.data.amount_minor);
    await recordAudit(scope, { action: "gift_card.adjust", entity: "gift_card", entityId: id, after: { amount_minor: b.data.amount_minor, note: b.data.note ?? null } });
    return NextResponse.json({ balance_minor: res.balanceAfter }, { status: 201 });
  } catch (err) {
    return fail(err, "engagement.giftcards.adjust");
  }
}
