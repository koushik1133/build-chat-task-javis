import { listCreditNotes } from "@/lib/money/credit-notes";
import { ROUTES } from "@/lib/public-api/registry";
import { op } from "@/lib/public-api/handler";
import { page } from "@/lib/public-api/pagination";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = op(ROUTES.listCreditNotes, async ({ principal, query, list }) => {
  const rows = await listCreditNotes(principal.dataId, { status: query.status, invoice_id: query.invoice_id, contact_id: query.contact_id, cursor: list.cursor, limit: list.limit + 1 });
  const p = page(rows, list.limit, (r) => ({ created_at: r.created_at, id: r.id }));
  return { data: p.data, meta: { next_cursor: p.next_cursor } };
});
