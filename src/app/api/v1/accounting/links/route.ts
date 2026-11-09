import { listLinks } from "@/lib/accounting/connections";
import { ROUTES } from "@/lib/public-api/registry";
import { op, singlePage } from "@/lib/public-api/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = op(ROUTES.listAccountingLinks, async ({ principal, query, list }) =>
  singlePage(await listLinks(principal.dataId, query.kind, { connectionId: query.connection_id ?? null, limit: list.limit }))
);
