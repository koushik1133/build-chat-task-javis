import { getRecord, getType, updateRecord } from "@/lib/records/store";
import { ROUTES } from "@/lib/public-api/registry";
import { ApiError } from "@/lib/public-api/envelope";
import { op, mustFind } from "@/lib/public-api/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = op(ROUTES.getRecord, async ({ principal, params }) => {
  const type = mustFind(await getType(principal.dataId, params.type), "Record type");
  const rec = await getRecord(principal.dataId, params.id);
  if (!rec || rec.type_id !== type.id || rec.deleted_at) throw ApiError.notFound("Record");
  return { data: rec };
});

export const PATCH = op(ROUTES.updateRecord, async ({ principal, params, body }) => {
  const type = mustFind(await getType(principal.dataId, params.type), "Record type");
  return { data: await updateRecord(principal.dataId, type, params.id, { ...body, actorId: `api_key:${principal.keyId}` }) };
});
