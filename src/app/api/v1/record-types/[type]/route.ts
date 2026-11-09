import { getType, updateType } from "@/lib/records/store";
import { ROUTES } from "@/lib/public-api/registry";
import { op, libCall, mustFind } from "@/lib/public-api/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const PATCH = op(ROUTES.updateRecordType, async ({ principal, params, body }) => {
  mustFind(await getType(principal.dataId, params.type), "Record type");
  return { data: await libCall(() => updateType(principal.dataId, params.type, body)) };
});
