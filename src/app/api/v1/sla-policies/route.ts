import { createPolicy, listPolicies } from "@/lib/helpdesk/tickets";
import { ROUTES } from "@/lib/public-api/registry";
import { op, libCall, singlePage } from "@/lib/public-api/handler";
import { slaPolicyView } from "@/lib/public-api/views";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = op(ROUTES.listSlaPolicies, async ({ principal }) => singlePage((await listPolicies(principal.dataId)).map(slaPolicyView)));

export const POST = op(ROUTES.createSlaPolicy, async ({ principal, body }) => ({ data: slaPolicyView(await libCall(() => createPolicy(principal.dataId, body))), status: 201 }));
