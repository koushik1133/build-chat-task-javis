import { ROUTES } from "@/lib/public-api/registry";
import { mustFind, op } from "@/lib/public-api/handler";
import { surveyResults } from "@/lib/engagement/surveys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = op(ROUTES.getSurveyResults, async ({ principal, params }) => ({ data: mustFind(await surveyResults(principal.dataId, params.id), "Survey") }));
