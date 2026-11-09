import { getCampaign, listTargets, statsFor } from "@/lib/voice/campaigns";
import { ROUTES } from "@/lib/public-api/registry";
import { op, mustFind } from "@/lib/public-api/handler";
import { campaignView } from "@/lib/public-api/views";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = op(ROUTES.getVoiceCampaign, async ({ principal, params }) => {
  const c = mustFind(await getCampaign(principal.dataId, params.id), "Campaign");
  const targets = await listTargets(principal.dataId, c.id, 5000);
  return { data: { ...campaignView(c), stats: statsFor(targets) } };
});
