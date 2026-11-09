import { ROUTES } from "@/lib/public-api/registry";
import { op } from "@/lib/public-api/handler";
import { page } from "@/lib/public-api/pagination";
import { listPlans } from "@/lib/memberships/plans";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = op(ROUTES.listMembershipPlans, async ({ principal, query, list }) => {
  const all = await listPlans(principal.dataId, { includeInactive: query.include_archived === "true" });
  const rows = all.map((p) => ({ ...p, members: undefined }));
  const p = page(rows.slice(0, list.limit + 1), list.limit, (r) => ({ created_at: r.created_at, id: r.id }));
  return { data: p.data, meta: { next_cursor: p.next_cursor } };
});
