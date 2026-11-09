import { getStaff } from "@/lib/workforce/staff";
import { ROUTES } from "@/lib/public-api/registry";
import { op, mustFind } from "@/lib/public-api/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = op(ROUTES.getStaff, async ({ principal, params }) => ({ data: mustFind(await getStaff(principal.dataId, params.id), "Staff profile") }));
