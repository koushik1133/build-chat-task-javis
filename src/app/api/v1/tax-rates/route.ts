import { listTaxRates } from "@/lib/money/tax-rates";
import { ROUTES } from "@/lib/public-api/registry";
import { op } from "@/lib/public-api/handler";
import { page } from "@/lib/public-api/pagination";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = op(ROUTES.listTaxRates, async ({ principal, query, list }) => {
  // Small catalogue: fetch all, slice in memory to keep the envelope shape consistent.
  const all = await listTaxRates(principal.dataId, { includeInactive: query.all === "true" });
  const cursorId = list.cursor?.id ?? null;
  const start = cursorId ? all.findIndex((r) => r.id === cursorId) + 1 : 0;
  const rows = all.slice(Math.max(start, 0), Math.max(start, 0) + list.limit + 1);
  const p = page(rows, list.limit, (r) => ({ created_at: r.created_at, id: r.id }));
  return { data: p.data, meta: { next_cursor: p.next_cursor } };
});
