import { listConnections } from "@/lib/accounting/connections";
import { ROUTES } from "@/lib/public-api/registry";
import { op, singlePage } from "@/lib/public-api/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = op(ROUTES.listAccountingConnections, async ({ principal }) => singlePage(await listConnections(principal.dataId)));
