import { ROUTES } from "@/lib/public-api/registry";
import { mustFind, op } from "@/lib/public-api/handler";
import { getSubscription } from "@/lib/memberships/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = op(ROUTES.getSubscription, async ({ principal, params }) => ({ data: mustFind(await getSubscription(principal.dataId, params.id), "Subscription") }));
