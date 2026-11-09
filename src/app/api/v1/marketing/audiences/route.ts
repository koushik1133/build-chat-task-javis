import { listAudiences } from "@/lib/marketing/audiences";
import { ROUTES } from "@/lib/public-api/registry";
import { op } from "@/lib/public-api/handler";
import { page } from "@/lib/public-api/pagination";
import { marketingAudienceView } from "@/lib/public-api/views";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = op(ROUTES.listMarketingAudiences, async ({ principal, list }) => {
  const all = await listAudiences(principal.dataId);
  const cursorId = list.cursor?.id ?? null;
  const start = cursorId ? all.findIndex((r) => r.id === cursorId) + 1 : 0;
  const rows = all.slice(Math.max(start, 0), Math.max(start, 0) + list.limit + 1);
  const p = page(rows, list.limit, (r) => ({ created_at: r.created_at, id: r.id }));
  return { data: p.data.map(marketingAudienceView), meta: { next_cursor: p.next_cursor } };
});
