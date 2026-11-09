import { listRequests, openRequest } from "@/lib/privacy/dsr";
import { ROUTES } from "@/lib/public-api/registry";
import { op, libCall, singlePage } from "@/lib/public-api/handler";
import { dsrView } from "@/lib/public-api/views";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = op(ROUTES.listDsr, async ({ principal, query, list }) => singlePage((await listRequests(principal.dataId, { status: query.status ?? null, limit: list.limit })).map(dsrView)));

export const POST = op(ROUTES.openDsr, async ({ principal, body }) => ({
  data: dsrView(
    await libCall(() =>
      openRequest(principal.dataId, { subject: { kind: body.subject_kind, id: body.subject_id }, kind: body.kind, source: "api", email: body.email ?? null, notes: body.notes ?? null, handledBy: `api_key:${principal.keyId}` })
    )
  ),
  status: 201,
}));
