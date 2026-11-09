import { getSchedule } from "@/lib/money/recurring";
import { ROUTES } from "@/lib/public-api/registry";
import { op, mustFind } from "@/lib/public-api/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = op(ROUTES.getInvoiceSchedule, async ({ principal, params }) => ({ data: mustFind(await getSchedule(principal.dataId, params.id), "Invoice schedule") }));
