import { createDocument, listDocuments } from "@/lib/documents/documents";
import { ROUTES } from "@/lib/public-api/registry";
import { op } from "@/lib/public-api/handler";
import { page } from "@/lib/public-api/pagination";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = op(ROUTES.listDocuments, async ({ principal, query, list }) => {
  const rows = await listDocuments(principal.dataId, { status: query.status ?? null, contactId: query.contact_id ?? null, q: query.q ?? null, cursor: list.cursor, limit: list.limit + 1 });
  const p = page(rows, list.limit, (r) => ({ created_at: r.created_at, id: r.id }));
  return { data: p.data, meta: { next_cursor: p.next_cursor } };
});

export const POST = op(ROUTES.createDocument, async ({ principal, body }) => ({ data: await createDocument(principal.dataId, body, null), status: 201 }));
