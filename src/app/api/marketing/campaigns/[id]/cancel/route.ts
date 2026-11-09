import { NextResponse, type NextRequest } from "next/server";
import { paramId } from "@/lib/money/http";
import { recordAudit } from "@/lib/audit";
import { cancelCampaign } from "@/lib/marketing/campaigns";
import { marketingError, marketingScope } from "@/lib/marketing/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/marketing/campaigns/[id]/cancel */
export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = await marketingScope(true);
  if (!s.ok) return s.res;
  try {
    const id = await paramId(ctx);
    const campaign = await cancelCampaign(s.scope.dataId, id);
    await recordAudit(s.scope, { action: "marketing.campaign.cancelled", entity: "campaign", entityId: id, after: { name: campaign.name } });
    return NextResponse.json({ campaign });
  } catch (err) {
    return marketingError(err, "marketing/campaigns.cancel");
  }
}
