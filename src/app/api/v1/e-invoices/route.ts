import { ROUTES } from "@/lib/public-api/registry";
import { op } from "@/lib/public-api/handler";
import { page } from "@/lib/public-api/pagination";
import { listEInvoices } from "@/lib/tax-compliance/einvoice/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = op(ROUTES.listEInvoices, async ({ principal, list }) => {
  const all = await listEInvoices(principal.dataId, 500);
  const start = list.cursor?.id ? all.findIndex((r) => r.id === list.cursor?.id) + 1 : 0;
  const rows = all.slice(Math.max(start, 0), Math.max(start, 0) + list.limit + 1);
  const p = page(rows, list.limit, (r) => ({ created_at: r.created_at, id: r.id }));
  return { data: p.data, meta: { next_cursor: p.next_cursor } };
});
