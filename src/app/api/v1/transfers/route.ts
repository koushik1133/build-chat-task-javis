import { createTransfer, listTransfers } from "@/lib/inventory/transfers";
import { ROUTES } from "@/lib/public-api/registry";
import { op, libCall, singlePage } from "@/lib/public-api/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = op(ROUTES.listTransfers, async ({ principal, query, list }) => singlePage(await listTransfers(principal.dataId, { status: query.status ?? null, limit: list.limit })));

export const POST = op(ROUTES.createTransfer, async ({ principal, body }) => ({ data: await libCall(() => createTransfer(principal.dataId, body, `api_key:${principal.keyId}`)), status: 201 }));
