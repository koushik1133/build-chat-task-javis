import { NextResponse, type NextRequest } from "next/server";
import { parseBody, paramId } from "@/lib/money/http";
import { recordAudit } from "@/lib/audit";
import { campaignStats, deleteCampaign, getCampaign, topLinks, updateCampaign } from "@/lib/marketing/campaigns";
import { marketingError, marketingScope } from "@/lib/marketing/http";
import { CampaignPatchSchema } from "@/lib/marketing/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, ctx: Ctx) {
  const s = await marketingScope(false);
  if (!s.ok) return s.res;
  try {
    const campaign = await getCampaign(s.scope.dataId, await paramId(ctx));
    if (!campaign) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const [stats, links] = await Promise.all([campaignStats(s.scope.dataId, campaign.id), topLinks(s.scope.dataId, campaign.id)]);
    return NextResponse.json({ campaign, stats, links });
  } catch (err) {
    return marketingError(err, "marketing/campaigns.get");
  }
}

export async function PATCH(req: NextRequest, ctx: Ctx) {
  const s = await marketingScope(true);
  if (!s.ok) return s.res;
  const body = await parseBody(req, CampaignPatchSchema, 80_000);
  if (!body.ok) return body.res;
  try {
    const campaign = await updateCampaign(s.scope.dataId, await paramId(ctx), { ...body.data, reply_to: body.data.reply_to === "" ? null : body.data.reply_to });
    await recordAudit(s.scope, { action: "marketing.campaign.updated", entity: "campaign", entityId: campaign.id, after: { summary: campaign.name } });
    return NextResponse.json({ campaign });
  } catch (err) {
    return marketingError(err, "marketing/campaigns.update");
  }
}

export async function DELETE(_req: NextRequest, ctx: Ctx) {
  const s = await marketingScope(true);
  if (!s.ok) return s.res;
  try {
    const id = await paramId(ctx);
    const ok = await deleteCampaign(s.scope.dataId, id);
    if (!ok) return NextResponse.json({ error: "not_found" }, { status: 404 });
    await recordAudit(s.scope, { action: "marketing.campaign.deleted", entity: "campaign", entityId: id });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return marketingError(err, "marketing/campaigns.delete");
  }
}
