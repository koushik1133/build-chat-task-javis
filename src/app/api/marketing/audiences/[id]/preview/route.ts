import { NextResponse, type NextRequest } from "next/server";
import { paramId } from "@/lib/money/http";
import { countAudience, eligibleCount, getAudience, resolveAudience } from "@/lib/marketing/audiences";
import { marketingError, marketingScope } from "@/lib/marketing/http";
import { parseAudienceDefinition } from "@/lib/marketing/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/marketing/audiences/[id]/preview?channel=email — count, consent-eligible count and sample contacts. */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = await marketingScope(false);
  if (!s.ok) return s.res;
  try {
    const audience = await getAudience(s.scope.dataId, await paramId(ctx));
    if (!audience) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const channelParam = req.nextUrl.searchParams.get("channel");
    const channel = channelParam === "sms" ? "sms" : "email";
    const def = parseAudienceDefinition(audience.definition);
    const [count, eligible, sample] = await Promise.all([countAudience(s.scope.dataId, def), eligibleCount(s.scope.dataId, def, channel), resolveAudience(s.scope.dataId, def, { limit: 10 })]);
    return NextResponse.json({ count, eligible: eligible.eligible, channel, sample });
  } catch (err) {
    return marketingError(err, "marketing/audiences.preview");
  }
}
