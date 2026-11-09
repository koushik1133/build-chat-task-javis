import { listCampaigns, statsForCampaigns } from "@/lib/marketing/campaigns";
import { ROUTES } from "@/lib/public-api/registry";
import { op } from "@/lib/public-api/handler";
import { page } from "@/lib/public-api/pagination";
import { marketingCampaignView } from "@/lib/public-api/views";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = op(ROUTES.listMarketingCampaigns, async ({ principal, query, list }) => {
  const rows = await listCampaigns(principal.dataId, { status: query.status ?? null, limit: list.limit + 1, cursor: list.cursor });
  const p = page(rows, list.limit, (r) => ({ created_at: r.created_at, id: r.id }));
  const stats = await statsForCampaigns(principal.dataId, p.data.map((c) => c.id));
  return { data: p.data.map((c) => ({ ...marketingCampaignView(c), stats: stats.get(c.id) })), meta: { next_cursor: p.next_cursor } };
});
