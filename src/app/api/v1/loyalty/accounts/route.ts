import { ROUTES } from "@/lib/public-api/registry";
import { op, singlePage } from "@/lib/public-api/handler";
import { listAccounts } from "@/lib/engagement/loyalty";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = op(ROUTES.listLoyaltyAccounts, async ({ principal, query }) => singlePage(await listAccounts(principal.dataId, { limit: query.limit })));
