import { createContact, listContacts } from "@/lib/crm/contacts";
import { ROUTES } from "@/lib/public-api/registry";
import { op } from "@/lib/public-api/handler";
import { page } from "@/lib/public-api/pagination";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = op(ROUTES.listContacts, async ({ principal, query, list }) => {
  const rows = await listContacts(principal.dataId, { q: query.q ?? list.q, lifecycle: query.lifecycle, domain: query.domain, cursor: list.cursor, limit: list.limit + 1 });
  const p = page(rows, list.limit, (r) => ({ created_at: r.created_at, id: r.id }));
  return { data: p.data, meta: { next_cursor: p.next_cursor } };
});

export const POST = op(ROUTES.createContact, async ({ principal, body }) => ({ data: await createContact(principal.dataId, body), status: 201 }));
