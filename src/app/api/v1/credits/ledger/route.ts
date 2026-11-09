import { listLedger } from "@/lib/credits/ledger";
import { ROUTES } from "@/lib/public-api/registry";
import { op, singlePage } from "@/lib/public-api/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = op(ROUTES.creditLedger, async ({ principal, list }) => singlePage(await listLedger(principal.dataId, list.limit)));
