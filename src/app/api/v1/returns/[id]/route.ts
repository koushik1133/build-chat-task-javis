import { ROUTES } from "@/lib/public-api/registry";
import { mustFind, op } from "@/lib/public-api/handler";
import { getReturn } from "@/lib/shipping/returns";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = op(ROUTES.getReturn, async ({ principal, params }) => ({ data: mustFind(await getReturn(principal.dataId, params.id), "Return") }));
