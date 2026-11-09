import { ROUTES } from "@/lib/public-api/registry";
import { op, singlePage } from "@/lib/public-api/handler";
import { listAutomations, redactAutomationSecrets, toAutomationDTO } from "@/lib/automations/store";
import { hasScope } from "@/lib/public-api/scopes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = op(ROUTES.listAutomations, async ({ principal, query, list }) =>
  singlePage(
    (
      await listAutomations(principal.dataId, {
        triggerType: query.trigger_type ?? null,
        enabled: query.enabled === undefined ? null : query.enabled === "true",
        limit: list.limit,
      })
    )
      .map(toAutomationDTO)
      .map((a) => (hasScope(principal.scopes, "write:agents") ? a : redactAutomationSecrets(a)))
  )
);
