import { NextResponse, type NextRequest } from "next/server";
import { paramId } from "@/lib/money/http";
import { campaignStats, getCampaign, topLinks } from "@/lib/marketing/campaigns";
import { marketingError, marketingScope } from "@/lib/marketing/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = await marketingScope(false);
  if (!s.ok) return s.res;
  try {
    const id = await paramId(ctx);
    const campaign = await getCampaign(s.scope.dataId, id);
    if (!campaign) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const [stats, links] = await Promise.all([campaignStats(s.scope.dataId, id), topLinks(s.scope.dataId, id)]);
    return NextResponse.json({ stats, links, status: campaign.status });
  } catch (err) {
    return marketingError(err, "marketing/campaigns.stats");
  }
}
