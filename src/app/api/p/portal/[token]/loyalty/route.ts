import { NextRequest, NextResponse } from "next/server";
import { redeemQuote } from "@/lib/engagement/loyalty";
import { portalLoyalty } from "@/lib/engagement/portal";
import { authPortalToken, clientIp } from "@/lib/portal-auth";
import { rateLimitAsync } from "@/lib/request-limits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/p/portal/[token]/loyalty[?subtotal_minor=N] -> balance, tier, history, referral code and (with a subtotal) the most points spendable. */
export async function GET(req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  if (!(await rateLimitAsync(`portal-loyalty:${clientIp(req)}`, 60, 60_000)).allowed) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  try {
    const auth = await authPortalToken((await ctx.params).token);
    if (!auth) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const loyalty = await portalLoyalty(auth.dataId, auth.contactId);
    if (!loyalty) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const sub = Number(req.nextUrl.searchParams.get("subtotal_minor"));
    const redeem = Number.isFinite(sub) && sub > 0 ? await redeemQuote(auth.dataId, auth.contactId, Math.trunc(sub)) : null;
    return NextResponse.json({ loyalty, redeem: redeem ? { max_points: redeem.maxPoints, max_value_minor: redeem.maxValueMinor } : null });
  } catch (err) {
    console.error("[portal] loyalty GET failed:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
