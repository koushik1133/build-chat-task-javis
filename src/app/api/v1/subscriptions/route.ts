import { ROUTES } from "@/lib/public-api/registry";
import { op } from "@/lib/public-api/handler";
import { page } from "@/lib/public-api/pagination";
import { listSubscriptions } from "@/lib/memberships/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = op(ROUTES.listSubscriptions, async ({ principal, query, list }) => {
  const rows = await listSubscriptions(principal.dataId, { status: query.status ?? null, planId: query.plan_id ?? null, contactId: query.contact_id ?? null, q: query.q ?? list.q, cursor: list.cursor, limit: list.limit + 1 });
  const p = page(rows, list.limit, (r) => ({ created_at: r.created_at, id: r.id }));
  return { data: p.data, meta: { next_cursor: p.next_cursor } };
});
