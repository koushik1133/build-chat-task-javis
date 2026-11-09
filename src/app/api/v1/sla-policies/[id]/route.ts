import { getPolicy, updatePolicy } from "@/lib/helpdesk/tickets";
import { ROUTES } from "@/lib/public-api/registry";
import { op, libCall, mustFind } from "@/lib/public-api/handler";
import { slaPolicyView } from "@/lib/public-api/views";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = op(ROUTES.getSlaPolicy, async ({ principal, params }) => ({ data: slaPolicyView(mustFind(await getPolicy(principal.dataId, params.id), "SLA policy")) }));

export const PATCH = op(ROUTES.updateSlaPolicy, async ({ principal, params, body }) => {
  mustFind(await getPolicy(principal.dataId, params.id), "SLA policy");
  return { data: slaPolicyView(await libCall(() => updatePolicy(principal.dataId, params.id, body))) };
});
