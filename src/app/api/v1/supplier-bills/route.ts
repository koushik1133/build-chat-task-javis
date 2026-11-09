import { createSupplierBill, listSupplierBills } from "@/lib/procurement/bills";
import { ROUTES } from "@/lib/public-api/registry";
import { op, libCall } from "@/lib/public-api/handler";
import { normaliseCursor, page } from "@/lib/public-api/pagination";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = op(ROUTES.listSupplierBills, async ({ principal, query, list }) => {
  const rows = await listSupplierBills(principal.dataId, { status: query.status ?? null, supplierId: query.supplier_id ?? null, overdueOnly: query.overdue === "true", cursor: list.cursor, limit: list.limit + 1 });
  const pg = page(rows, list.limit, (r) => normaliseCursor({ created_at: r.created_at, id: r.id }));
  return { data: pg.data, meta: { next_cursor: pg.next_cursor } };
});

export const POST = op(ROUTES.createSupplierBill, async ({ principal, body }) => ({ data: await libCall(() => createSupplierBill(principal.dataId, body)), status: 201 }));
