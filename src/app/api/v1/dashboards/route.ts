import { listDashboards } from "@/lib/reports/store";
import { ROUTES } from "@/lib/public-api/registry";
import { op, singlePage } from "@/lib/public-api/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = op(ROUTES.listDashboards, async ({ principal }) => singlePage(await listDashboards(principal.dataId)));
