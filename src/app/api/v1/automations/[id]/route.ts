import { ROUTES } from "@/lib/public-api/registry";
import { op, mustFind } from "@/lib/public-api/handler";
import { getAutomation, redactAutomationSecrets, toAutomationDTO } from "@/lib/automations/store";
import { hasScope } from "@/lib/public-api/scopes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = op(ROUTES.getAutomation, async ({ principal, params }) => {
  const dto = toAutomationDTO(mustFind(await getAutomation(principal.dataId, params.id), "Automation"));
  return { data: hasScope(principal.scopes, "write:agents") ? dto : redactAutomationSecrets(dto) };
});
