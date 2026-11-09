import { createStaff, listStaff } from "@/lib/workforce/staff";
import { ROUTES } from "@/lib/public-api/registry";
import { op, libCall, singlePage } from "@/lib/public-api/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = op(ROUTES.listStaff, async ({ principal, query, list }) => singlePage(await listStaff(principal.dataId, { includeInactive: query.all === "true", limit: list.limit })));

export const POST = op(ROUTES.createStaff, async ({ principal, body }) => ({ data: await libCall(() => createStaff(principal.dataId, body)), status: 201 }));
