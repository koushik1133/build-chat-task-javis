import { createType, listTypes } from "@/lib/records/store";
import { ROUTES } from "@/lib/public-api/registry";
import { op, libCall } from "@/lib/public-api/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = op(ROUTES.listRecordTypes, async ({ principal }) => ({ data: await listTypes(principal.dataId), meta: { next_cursor: null } }));

export const POST = op(ROUTES.createRecordType, async ({ principal, body }) => ({ data: await libCall(() => createType(principal.dataId, body)), status: 201 }));
