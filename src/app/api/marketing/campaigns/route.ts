import { NextResponse, type NextRequest } from "next/server";
import { parseBody } from "@/lib/money/http";
import { recordAudit } from "@/lib/audit";
import { tableExists } from "@/lib/table-exists";
import { decodeCursor, encodeCursor } from "@/lib/public-api/pagination";
import { createCampaign, launchCampaign, listCampaigns, statsForCampaigns } from "@/lib/marketing/campaigns";
import { marketingError, marketingScope } from "@/lib/marketing/http";
import { CampaignCreateSchema, CampaignListQuerySchema } from "@/lib/marketing/schemas";
import { channelStatus } from "@/lib/notifications/status";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const s = await marketingScope(false);
  if (!s.ok) return s.res;
  const q = CampaignListQuerySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!q.success) return NextResponse.json({ error: "invalid_query", detail: q.error.flatten() }, { status: 400 });
  try {
    const migrated = await tableExists("campaigns");
    if (!migrated) return NextResponse.json({ campaigns: [], next_cursor: null, migrated: false, channels: channelStatus() });
    const limit = q.data.limit ?? 50;
    const rows = await listCampaigns(s.scope.dataId, { status: q.data.status ?? null, limit: limit + 1, cursor: decodeCursor(q.data.cursor) });
    const pageRows = rows.slice(0, limit);
    const stats = await statsForCampaigns(s.scope.dataId, pageRows.map((c) => c.id));
    const last = pageRows[pageRows.length - 1];
    return NextResponse.json({
      campaigns: pageRows.map((c) => ({ ...c, stats: stats.get(c.id) })),
      next_cursor: rows.length > limit && last ? encodeCursor({ created_at: last.created_at, id: last.id }) : null,
      migrated: true,
      channels: channelStatus(),
    });
  } catch (err) {
    return marketingError(err, "marketing/campaigns.list");
  }
}

export async function POST(req: NextRequest) {
  const s = await marketingScope(true);
  if (!s.ok) return s.res;
  const body = await parseBody(req, CampaignCreateSchema, 80_000);
  if (!body.ok) return body.res;
  try {
    const { launch, ...input } = body.data;
    let campaign = await createCampaign(s.scope.dataId, { ...input, reply_to: input.reply_to || null }, s.scope.userId);
    let launchResult: { queued: number; skipped_no_consent: number; skipped_no_address: number } | null = null;
    if (launch) {
      const r = await launchCampaign(s.scope.dataId, campaign.id);
      campaign = r.campaign;
      launchResult = { queued: r.queued, skipped_no_consent: r.skipped_no_consent, skipped_no_address: r.skipped_no_address };
    }
    await recordAudit(s.scope, { action: launch ? "marketing.campaign.launched" : "marketing.campaign.created", entity: "campaign", entityId: campaign.id, after: { summary: campaign.name } });
    return NextResponse.json({ campaign, launch: launchResult }, { status: 201 });
  } catch (err) {
    return marketingError(err, "marketing/campaigns.create");
  }
}
