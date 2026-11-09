import { ROUTES } from "@/lib/public-api/registry";
import { op } from "@/lib/public-api/handler";
import { page } from "@/lib/public-api/pagination";
import { ApiError } from "@/lib/public-api/envelope";
import { listMessagesPage, PortalMessageError, replyToContact, type PortalMessageRow } from "@/lib/portal-messages";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function view(r: PortalMessageRow) {
  return {
    id: r.id,
    contact_id: r.contact_id,
    direction: r.direction,
    body: r.body,
    author_member_id: r.author_member_id,
    read_at: r.read_at ? new Date(r.read_at).toISOString() : null,
    created_at: new Date(r.created_at).toISOString(),
  };
}

export const GET = op(ROUTES.listPortalMessages, async ({ principal, query, list }) => {
  const rows = await listMessagesPage(principal.dataId, { contactId: query.contact_id ?? null, cursor: list.cursor, limit: list.limit + 1 });
  const p = page(rows, list.limit, (r) => ({ created_at: new Date(r.created_at).toISOString(), id: r.id }));
  return { data: p.data.map(view), meta: { next_cursor: p.next_cursor } };
});

export const POST = op(ROUTES.createPortalMessage, async ({ principal, body }) => {
  try {
    const row = await replyToContact(principal.dataId, body.contact_id, body.body, `api_key:${principal.keyId}`);
    return { data: view(row), status: 201 };
  } catch (err) {
    if (err instanceof PortalMessageError) throw err.status === 404 ? ApiError.notFound("Contact") : ApiError.badRequest(err.message);
    throw err;
  }
});
