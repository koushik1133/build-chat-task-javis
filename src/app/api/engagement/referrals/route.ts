import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { body, engScope, fail, isResponse, limitParam, writeLimit } from "@/lib/engagement/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
import { getOrCreateReferralCode, listReferrals } from "@/lib/engagement/referrals";
import { trackingOrigin } from "@/lib/marketing/tracking";
import { getStorefront } from "@/lib/storefront/settings";

export async function GET(req: NextRequest) {
  const scope = await engScope("crm", false);
  if (isResponse(scope)) return scope;
  try {
    return NextResponse.json({ referrals: await listReferrals(scope.dataId, { status: req.nextUrl.searchParams.get("status"), limit: limitParam(req, 100) }) });
  } catch (err) {
    return fail(err, "engagement.referrals.GET");
  }
}

/** POST { contact_id } → the contact's referral code and share link. */
export async function POST(req: NextRequest) {
  const scope = await engScope("crm", true);
  if (isResponse(scope)) return scope;
  const limited = await writeLimit(scope, "referrals");
  if (limited) return limited;
  const b = await body(req, z.object({ contact_id: z.string().min(1).max(100) }).strict());
  if (!b.ok) return b.res;
  try {
    const code = await getOrCreateReferralCode(scope.dataId, b.data.contact_id);
    const sf = await getStorefront(scope.dataId).catch(() => null);
    return NextResponse.json({ code, url: sf ? `${trackingOrigin()}/shop/${encodeURIComponent(sf.slug)}?ref=${code}` : null }, { status: 201 });
  } catch (err) {
    return fail(err, "engagement.referrals.POST");
  }
}
