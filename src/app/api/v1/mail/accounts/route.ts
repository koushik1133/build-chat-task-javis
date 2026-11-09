import { listMailAccounts } from "@/lib/mail";
import { ROUTES } from "@/lib/public-api/registry";
import { op, singlePage } from "@/lib/public-api/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = op(ROUTES.listMailAccounts, async ({ principal }) => singlePage(await listMailAccounts(principal.dataId)));
