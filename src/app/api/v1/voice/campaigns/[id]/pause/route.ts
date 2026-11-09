import { canTransition, getCampaign, setCampaignStatus } from "@/lib/voice/campaigns";
import { ROUTES } from "@/lib/public-api/registry";
import { ApiError } from "@/lib/public-api/envelope";
import { op, mustFind } from "@/lib/public-api/handler";
import { campaignView } from "@/lib/public-api/views";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = op(ROUTES.pauseVoiceCampaign, async ({ principal, params }) => {
  const c = mustFind(await getCampaign(principal.dataId, params.id), "Campaign");
  if (!canTransition(c.status, "paused")) throw new ApiError(409, "conflict", `Cannot move a ${c.status} campaign to paused`);
  const row = await setCampaignStatus(principal.dataId, c.id, "paused");
  return { data: campaignView(row ?? { ...c, status: "paused" }) };
});
