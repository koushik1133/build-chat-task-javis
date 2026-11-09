import { ROUTES } from "@/lib/public-api/registry";
import { mustFind, op } from "@/lib/public-api/handler";
import { getPlan } from "@/lib/memberships/plans";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = op(ROUTES.getMembershipPlan, async ({ principal, params }) => ({ data: mustFind(await getPlan(principal.dataId, params.id), "Membership plan") }));
