import { listLeave, requestLeave } from "@/lib/workforce/leave";
import { ROUTES } from "@/lib/public-api/registry";
import { op, libCall, singlePage } from "@/lib/public-api/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = op(ROUTES.listLeave, async ({ principal, query, list }) =>
  singlePage(await listLeave(principal.dataId, { status: query.status ?? null, staffId: query.staff_id ?? null, from: query.from ?? null, to: query.to ?? null, limit: list.limit }))
);

export const POST = op(ROUTES.createLeave, async ({ principal, body }) => ({ data: await libCall(() => requestLeave(principal.dataId, body, `api_key:${principal.keyId}`)), status: 201 }));
