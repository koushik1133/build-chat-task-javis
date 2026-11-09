import { NextRequest, NextResponse } from "next/server";
import { planGate } from "@/lib/plans/http";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { tableExists } from "@/lib/table-exists";
import { addTargets, createCampaign, listCampaigns, setCampaignStatus } from "@/lib/voice/campaigns";
import { voiceMode } from "@/lib/voice/dialer";
import { createCampaignSchema } from "@/lib/voice/schemas";
import { VOICES } from "@/lib/voice/twiml";
import { parseHm } from "@/lib/voice/window";

export const dynamic = "force-dynamic";

export async function GET() {
  let scope;
  try {
    scope = await requireScope({ area: "messaging", edit: false });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const ready = await tableExists("voice_campaigns");
    const campaigns = ready ? await listCampaigns(scope.dataId) : [];
    return NextResponse.json({ campaigns, mode: voiceMode(), migrated: ready, voices: VOICES });
  } catch (err) {
    console.error("[voice/campaigns] list failed:", err);
    return NextResponse.json({ error: "Could not load campaigns." }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  let scope;
  try {
    scope = await requireScope({ area: "messaging", edit: true });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const gate = await planGate(scope, { feature: "voice_campaigns" });
  if (gate) return gate;
  const parsed = createCampaignSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid body", detail: parsed.error.flatten() }, { status: 400 });
  }
  const input = parsed.data;
  if (parseHm(input.window_start) === parseHm(input.window_end)) {
    return NextResponse.json({ error: "The calling window must have a start and end that differ." }, { status: 400 });
  }
  try {
    const campaign = await createCampaign(scope.dataId, {
      name: input.name,
      script: input.script,
      voice: input.voice,
      schedule_at: input.schedule_at ?? null,
      window_start: input.window_start,
      window_end: input.window_end,
      timezone: input.timezone,
      max_attempts: input.max_attempts,
      created_by: scope.userId,
    });
    const audience = input.audience ? await addTargets(scope.dataId, campaign.id, input.audience) : null;
    let status = campaign.status;
    if (input.start) {
      const next = input.schedule_at && new Date(input.schedule_at).getTime() > Date.now() ? "scheduled" : "running";
      const updated = await setCampaignStatus(scope.dataId, campaign.id, next);
      status = updated?.status ?? status;
    }
    return NextResponse.json({ campaign: { ...campaign, status }, audience, mode: voiceMode() }, { status: 201 });
  } catch (err) {
    console.error("[voice/campaigns] create failed:", err);
    return NextResponse.json({ error: "Could not create the campaign. Has the Phase 4 migration been applied?" }, { status: 500 });
  }
}
