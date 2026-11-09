import { getTimeEntry } from "@/lib/finance/time";
import { ROUTES } from "@/lib/public-api/registry";
import { op, mustFind } from "@/lib/public-api/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = op(ROUTES.getTimeEntry, async ({ principal, params }) => ({ data: mustFind(await getTimeEntry(principal.dataId, params.id), "Time entry") }));
