import { createSupplier, listSuppliers } from "@/lib/procurement/suppliers";
import { ROUTES } from "@/lib/public-api/registry";
import { op, libCall } from "@/lib/public-api/handler";
import { normaliseCursor, page } from "@/lib/public-api/pagination";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = op(ROUTES.listSuppliers, async ({ principal, query, list }) => {
  const rows = await listSuppliers(principal.dataId, { q: query.q ?? null, includeInactive: query.inactive === "true", order: "created", cursor: list.cursor, limit: list.limit + 1 });
  const pg = page(rows, list.limit, (r) => normaliseCursor({ created_at: r.created_at, id: r.id }));
  return { data: pg.data, meta: { next_cursor: pg.next_cursor } };
});

export const POST = op(ROUTES.createSupplier, async ({ principal, body }) => ({ data: await libCall(() => createSupplier(principal.dataId, body)), status: 201 }));
