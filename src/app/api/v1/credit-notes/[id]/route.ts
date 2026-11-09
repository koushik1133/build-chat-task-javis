import { getCreditNote } from "@/lib/money/credit-notes";
import { ROUTES } from "@/lib/public-api/registry";
import { op, mustFind } from "@/lib/public-api/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = op(ROUTES.getCreditNote, async ({ principal, params }) => ({ data: mustFind(await getCreditNote(principal.dataId, params.id), "Credit note") }));
