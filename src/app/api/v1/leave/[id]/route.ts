import { getLeave } from "@/lib/workforce/leave";
import { ROUTES } from "@/lib/public-api/registry";
import { op, mustFind } from "@/lib/public-api/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = op(ROUTES.getLeave, async ({ principal, params }) => ({ data: mustFind(await getLeave(principal.dataId, params.id), "Leave request") }));
