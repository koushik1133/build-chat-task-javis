import { ROUTES } from "@/lib/public-api/registry";
import { libCall, op, singlePage } from "@/lib/public-api/handler";
import { createVoucher, listVouchers } from "@/lib/engagement/vouchers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = op(ROUTES.listVouchers, async ({ principal, query }) => singlePage(await listVouchers(principal.dataId, { limit: query.limit })));
export const POST = op(ROUTES.createVoucher, async ({ principal, body }) => ({ data: await libCall(() => createVoucher(principal.dataId, body)), status: 201 }));
