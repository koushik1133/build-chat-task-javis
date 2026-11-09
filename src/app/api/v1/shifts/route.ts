import { createShift, listShifts } from "@/lib/workforce/shifts";
import { ROUTES } from "@/lib/public-api/registry";
import { op, libCall, singlePage } from "@/lib/public-api/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = op(ROUTES.listShifts, async ({ principal, query, list }) =>
  singlePage(await listShifts(principal.dataId, { from: query.from ?? null, to: query.to ?? null, staffId: query.staff_id ?? null, status: query.status ?? null, limit: list.limit }))
);

export const POST = op(ROUTES.createShift, async ({ principal, body }) => ({ data: await libCall(() => createShift(principal.dataId, body)), status: 201 }));
