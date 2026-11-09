import { getBalance } from "@/lib/credits/ledger";
import { ROUTES } from "@/lib/public-api/registry";
import { op } from "@/lib/public-api/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = op(ROUTES.creditBalance, async ({ principal }) => ({ data: { balance: await getBalance(principal.dataId) } }));
