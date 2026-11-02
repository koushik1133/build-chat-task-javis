import { NextResponse } from "next/server";
import { z } from "zod";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { getBalance, listLedger } from "@/lib/credits/ledger";
import { listPurchases } from "@/lib/credits/checkout";
import { CREDIT_PACKS } from "@/lib/credits/packs";
import { creditMarkup } from "@/lib/credits/pricing";
import { getBudget, setBudget } from "@/lib/llm/budgets";
import { activeProviderId } from "@/lib/payments";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** GET /api/ai/credits → balance, recent ledger, purchases, packs and enforcement. */
export async function GET(req: Request) {
  let scope;
  try {
    scope = await requireScope({ area: "settings", edit: false });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = new URL(req.url);
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 50) || 50, 1), 200);
  try {
    const [balance, ledger, purchases, budget] = await Promise.all([
      getBalance(scope.dataId),
      listLedger(scope.dataId, limit),
      listPurchases(scope.dataId, 10),
      getBudget(scope.dataId),
    ]);
    return NextResponse.json({
      balance,
      ledger,
      purchases,
      packs: CREDIT_PACKS,
      creditsEnforced: budget.creditsEnforced,
      markup: creditMarkup(),
      provider: activeProviderId(),
    });
  } catch (err) {
    console.error("[ai/credits] get failed:", err);
    return NextResponse.json({ error: "Could not load AI credits." }, { status: 500 });
  }
}

const Patch = z.object({ creditsEnforced: z.boolean() }).strict();

/** PATCH /api/ai/credits { creditsEnforced } → toggle enforcement. */
export async function PATCH(req: Request) {
  let scope;
  try {
    scope = await requireScope({ area: "settings", edit: true });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const parsed = Patch.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad request" }, { status: 400 });
  try {
    await setBudget(scope.dataId, { creditsEnforced: parsed.data.creditsEnforced });
    const budget = await getBudget(scope.dataId);
    return NextResponse.json({ creditsEnforced: budget.creditsEnforced });
  } catch (err) {
    console.error("[ai/credits] patch failed:", err);
    return NextResponse.json({ error: "Could not save credit enforcement." }, { status: 500 });
  }
}
