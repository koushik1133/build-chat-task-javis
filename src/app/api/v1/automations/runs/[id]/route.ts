import { ROUTES } from "@/lib/public-api/registry";
import { op, mustFind } from "@/lib/public-api/handler";
import { getRun, toPublicRunDTO } from "@/lib/automations/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = op(ROUTES.getAutomationRun, async ({ principal, params }) => {
  return { data: toPublicRunDTO(mustFind(await getRun(principal.dataId, params.id), "Automation run")) };
});
