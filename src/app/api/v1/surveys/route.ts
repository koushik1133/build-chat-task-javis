import { ROUTES } from "@/lib/public-api/registry";
import { op, singlePage } from "@/lib/public-api/handler";
import { listSurveys } from "@/lib/engagement/surveys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = op(ROUTES.listSurveys, async ({ principal }) => singlePage(await listSurveys(principal.dataId)));
