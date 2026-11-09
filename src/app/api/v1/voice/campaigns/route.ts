import { createCampaign, listCampaigns } from "@/lib/voice/campaigns";
import { DEFAULT_VOICE } from "@/lib/voice/twiml";
import { ROUTES } from "@/lib/public-api/registry";
import { op, libCall, singlePage } from "@/lib/public-api/handler";
import { campaignView } from "@/lib/public-api/views";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = op(ROUTES.listVoiceCampaigns, async ({ principal, list }) =>
  singlePage((await listCampaigns(principal.dataId)).slice(0, list.limit).map((c) => ({ ...campaignView(c), stats: c.stats })))
);

export const POST = op(ROUTES.createVoiceCampaign, async ({ principal, body }) => ({
  data: campaignView(
    await libCall(() =>
      createCampaign(principal.dataId, {
        name: body.name,
        script: body.script,
        voice: body.voice ?? DEFAULT_VOICE,
        schedule_at: body.schedule_at ?? null,
        window_start: body.window_start ?? "09:00",
        window_end: body.window_end ?? "18:00",
        timezone: body.timezone ?? "UTC",
        max_attempts: body.max_attempts ?? 2,
        require_consent: body.require_consent ?? true,
        created_by: `api_key:${principal.keyId}`,
      })
    )
  ),
  status: 201,
}));
