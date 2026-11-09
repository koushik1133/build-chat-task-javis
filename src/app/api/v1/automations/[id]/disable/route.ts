import { ROUTES } from "@/lib/public-api/registry";
import { op, mustFind } from "@/lib/public-api/handler";
import { setEnabled, toAutomationDTO } from "@/lib/automations/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = op(ROUTES.disableAutomation, async ({ principal, params }) => ({
  data: toAutomationDTO(mustFind(await setEnabled(principal.dataId, params.id, false), "Automation")),
}));
