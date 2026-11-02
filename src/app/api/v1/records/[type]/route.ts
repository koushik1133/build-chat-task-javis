import { createRecord, getType, listRecords } from "@/lib/records/store";
import { ROUTES } from "@/lib/public-api/registry";
import { op, mustFind } from "@/lib/public-api/handler";
import { page } from "@/lib/public-api/pagination";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = op(ROUTES.listRecords, async ({ principal, params, query, list }) => {
  const type = mustFind(await getType(principal.dataId, params.type), "Record type");
  const rows = await listRecords(principal.dataId, type, { stage: query.stage ?? null, q: query.q ?? list.q, order: "created", cursor: list.cursor, limit: list.limit + 1 });
  const p = page(rows, list.limit, (r) => ({ created_at: r.created_at, id: r.id }));
  return { data: p.data, meta: { next_cursor: p.next_cursor, type: { id: type.id, slug: type.slug, name: type.name } } };
});

export const POST = op(ROUTES.createRecord, async ({ principal, params, body }) => {
  const type = mustFind(await getType(principal.dataId, params.type), "Record type");
  return { data: await createRecord(principal.dataId, type, { ...body, actorId: `api_key:${principal.keyId}` }), status: 201 };
});
