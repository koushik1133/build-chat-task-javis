import { createProduct, listProducts } from "@/lib/inventory/products";
import { ROUTES } from "@/lib/public-api/registry";
import { op } from "@/lib/public-api/handler";
import { page } from "@/lib/public-api/pagination";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = op(ROUTES.listProducts, async ({ principal, query, list }) => {
  const rows = await listProducts(principal.dataId, {
    q: query.q ?? list.q ?? undefined,
    kind: query.kind,
    low: query.low === "true",
    includeInactive: query.include_inactive === "true",
    order: "created",
    cursor: list.cursor,
    limit: list.limit + 1,
  });
  const p = page(rows, list.limit, (r) => ({ created_at: r.created_at, id: r.id }));
  return { data: p.data, meta: { next_cursor: p.next_cursor } };
});

export const POST = op(ROUTES.createProduct, async ({ principal, body }) => ({ data: await createProduct(principal.dataId, body, `api_key:${principal.keyId}`), status: 201 }));
