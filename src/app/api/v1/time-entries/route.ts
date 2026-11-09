import { createTimeEntry, listTimeEntries } from "@/lib/finance/time";
import { ROUTES } from "@/lib/public-api/registry";
import { op, libCall, singlePage } from "@/lib/public-api/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = op(ROUTES.listTimeEntries, async ({ principal, query, list }) =>
  singlePage(
    await listTimeEntries(principal.dataId, {
      from: query.from ?? null,
      to: query.to ?? null,
      refKind: query.ref_kind ?? null,
      refId: query.ref_id ?? null,
      memberId: query.member_id ?? null,
      runningOnly: query.running === "true",
      unbilledOnly: query.unbilled === "true",
      limit: list.limit,
    })
  )
);

export const POST = op(ROUTES.createTimeEntry, async ({ principal, body }) => ({
  data: await libCall(() => createTimeEntry(principal.dataId, body, `api_key:${principal.keyId}`)),
  status: 201,
}));
