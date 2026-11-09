import { stopTimer } from "@/lib/finance/time";
import { ROUTES } from "@/lib/public-api/registry";
import { op, libCall } from "@/lib/public-api/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = op(ROUTES.stopTimer, async ({ principal, params, body }) => ({ data: await libCall(() => stopTimer(principal.dataId, params.id, body.ended_at)) }));
