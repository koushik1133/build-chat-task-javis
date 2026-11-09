import { campaignStats, getCampaign } from "@/lib/marketing/campaigns";
import { ROUTES } from "@/lib/public-api/registry";
import { mustFind, op } from "@/lib/public-api/handler";
import { marketingCampaignView } from "@/lib/public-api/views";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = op(ROUTES.getMarketingCampaign, async ({ principal, params }) => {
  const c = mustFind(await getCampaign(principal.dataId, params.id), "campaign");
  return { data: { ...marketingCampaignView(c), stats: await campaignStats(principal.dataId, c.id) } };
});
