import { NextResponse, type NextRequest } from "next/server";
import { paramId } from "@/lib/money/http";
import { recordAudit } from "@/lib/audit";
import { launchCampaign } from "@/lib/marketing/campaigns";
import { marketingError, marketingScope } from "@/lib/marketing/http";
import { LaunchSchema } from "@/lib/marketing/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/marketing/campaigns/[id]/launch { force? } — materialise consent-checked recipients and start sending. */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = await marketingScope(true);
  if (!s.ok) return s.res;
  const parsed = LaunchSchema.safeParse((await req.json().catch(() => null)) ?? {});
  if (!parsed.success) return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  try {
    const id = await paramId(ctx);
    const r = await launchCampaign(s.scope.dataId, id, { force: parsed.data.force });
    await recordAudit(s.scope, { action: "marketing.campaign.launched", entity: "campaign", entityId: id, after: { queued: r.queued, skipped_no_consent: r.skipped_no_consent } });
    return NextResponse.json({ campaign: r.campaign, queued: r.queued, skipped_no_consent: r.skipped_no_consent, skipped_no_address: r.skipped_no_address });
  } catch (err) {
    return marketingError(err, "marketing/campaigns.launch");
  }
}
