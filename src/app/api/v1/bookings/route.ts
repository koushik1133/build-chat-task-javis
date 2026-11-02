import { listBookings } from "@/lib/calendar/booking";
import { ROUTES } from "@/lib/public-api/registry";
import { ApiError } from "@/lib/public-api/envelope";
import { op } from "@/lib/public-api/handler";
import { page } from "@/lib/public-api/pagination";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parseDate(v: string | undefined, name: string): Date | null {
  if (!v) return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw ApiError.validation([{ in: "query", path: name, message: "must be an ISO-8601 date" }]);
  return d;
}

export const GET = op(ROUTES.listBookings, async ({ principal, query, list }) => {
  const rows = await listBookings(principal.dataId, {
    from: parseDate(query.from, "from"),
    to: parseDate(query.to, "to"),
    status: query.status ?? null,
    cursor: list.cursor,
    limit: list.limit + 1,
  });
  const p = page(rows, list.limit, (r) => ({ created_at: r.created_at, id: r.id }));
  return { data: p.data, meta: { next_cursor: p.next_cursor } };
});
