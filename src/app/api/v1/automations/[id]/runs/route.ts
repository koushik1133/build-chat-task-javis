import { ROUTES } from "@/lib/public-api/registry";
import { op, mustFind, singlePage } from "@/lib/public-api/handler";
import { getAutomation, listRuns, toPublicRunDTO } from "@/lib/automations/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = op(ROUTES.listAutomationRuns, async ({ principal, params, query, list }) => {
  mustFind(await getAutomation(principal.dataId, params.id), "Automation");
  const rows = await listRuns(principal.dataId, { automationId: params.id, status: query.status ?? null, limit: list.limit });
  return singlePage(rows.map(toPublicRunDTO));
});
