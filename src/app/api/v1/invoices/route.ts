import { createInvoice, listInvoices } from "@/lib/money/invoices";
import { ROUTES } from "@/lib/public-api/registry";
import { op } from "@/lib/public-api/handler";
import { page } from "@/lib/public-api/pagination";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = op(ROUTES.listInvoices, async ({ principal, query, list }) => {
  const rows = await listInvoices(principal.dataId, { status: query.status, cursor: list.cursor, limit: list.limit + 1 });
  const p = page(rows, list.limit, (r) => ({ created_at: r.created_at, id: r.id }));
  return { data: p.data, meta: { next_cursor: p.next_cursor } };
});

export const POST = op(ROUTES.createInvoice, async ({ principal, body }) => ({ data: await createInvoice(principal.dataId, body), status: 201 }));
