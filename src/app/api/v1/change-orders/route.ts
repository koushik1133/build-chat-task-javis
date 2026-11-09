import { createChangeOrder, listChangeOrders } from "@/lib/finance/change-orders";
import { ROUTES } from "@/lib/public-api/registry";
import { op, libCall, singlePage } from "@/lib/public-api/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = op(ROUTES.listChangeOrders, async ({ principal, query, list }) =>
  singlePage(await listChangeOrders(principal.dataId, { quoteId: query.quote_id ?? null, invoiceId: query.invoice_id ?? null, status: query.status ?? null, limit: list.limit }))
);

export const POST = op(ROUTES.createChangeOrder, async ({ principal, body }) => ({ data: await libCall(() => createChangeOrder(principal.dataId, body)), status: 201 }));
