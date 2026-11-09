import { ROUTES } from "@/lib/public-api/registry";
import { op, mustFind } from "@/lib/public-api/handler";
import { getAutomation, toAutomationDTO } from "@/lib/automations/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = op(ROUTES.getAutomation, async ({ principal, params }) => ({
  data: toAutomationDTO(mustFind(await getAutomation(principal.dataId, params.id), "Automation")),
}));
