import { NextResponse } from "next/server";
import { engScope, fail, isResponse } from "@/lib/engagement/http";
import { getAccount, listLedger } from "@/lib/engagement/loyalty";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ contactId: string }> }) {
  const scope = await engScope("crm", false);
  if (isResponse(scope)) return scope;
  try {
    const account = await getAccount(scope.dataId, (await ctx.params).contactId);
    if (!account) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ account, ledger: await listLedger(scope.dataId, account.id, 100) });
  } catch (err) {
    return fail(err, "engagement.loyalty.account.GET");
  }
}
