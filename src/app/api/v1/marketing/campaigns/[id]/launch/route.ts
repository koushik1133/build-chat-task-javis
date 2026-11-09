import { launchCampaign } from "@/lib/marketing/campaigns";
import { ROUTES } from "@/lib/public-api/registry";
import { libCall, op } from "@/lib/public-api/handler";
import { marketingCampaignView } from "@/lib/public-api/views";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = op(ROUTES.launchMarketingCampaign, async ({ principal, params, body }) => {
  const r = await libCall(() => launchCampaign(principal.dataId, params.id, { force: body.force }));
  return { data: { ...marketingCampaignView(r.campaign), queued: r.queued, skipped_no_consent: r.skipped_no_consent, skipped_no_address: r.skipped_no_address } };
});
