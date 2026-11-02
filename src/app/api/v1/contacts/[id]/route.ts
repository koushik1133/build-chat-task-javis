import { deleteContact, getContact, updateContact } from "@/lib/crm/contacts";
import { ROUTES } from "@/lib/public-api/registry";
import { ApiError } from "@/lib/public-api/envelope";
import { op, mustFind } from "@/lib/public-api/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = op(ROUTES.getContact, async ({ principal, params }) => ({ data: mustFind(await getContact(principal.dataId, params.id), "Contact") }));

export const PATCH = op(ROUTES.updateContact, async ({ principal, params, body }) => ({ data: await updateContact(principal.dataId, params.id, body) }));

export const DELETE = op(ROUTES.deleteContact, async ({ principal, params }) => {
  if (!(await deleteContact(principal.dataId, params.id))) throw ApiError.notFound("Contact");
  return { data: { id: params.id, deleted: true as const } };
});
