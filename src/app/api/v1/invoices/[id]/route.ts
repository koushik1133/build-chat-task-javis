import { getInvoice } from "@/lib/money/invoices";
import { ROUTES } from "@/lib/public-api/registry";
import { op, mustFind } from "@/lib/public-api/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = op(ROUTES.getInvoice, async ({ principal, params }) => ({ data: mustFind(await getInvoice(principal.dataId, params.id), "Invoice") }));
