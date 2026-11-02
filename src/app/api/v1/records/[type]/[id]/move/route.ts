import { getType, moveRecord } from "@/lib/records/store";
import { ROUTES } from "@/lib/public-api/registry";
import { op, mustFind } from "@/lib/public-api/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = op(ROUTES.moveRecord, async ({ principal, params, body }) => {
  const type = mustFind(await getType(principal.dataId, params.type), "Record type");
  return { data: await moveRecord(principal.dataId, type, params.id, body.stage, `api_key:${principal.keyId}`) };
});
