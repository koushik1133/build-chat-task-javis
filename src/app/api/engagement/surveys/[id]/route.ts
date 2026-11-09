import { NextRequest, NextResponse } from "next/server";
import { recordAudit } from "@/lib/audit";
import { body, engScope, fail, isResponse, writeLimit } from "@/lib/engagement/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
import { SurveyInputSchema, getSurvey, updateSurvey } from "@/lib/engagement/surveys";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, ctx: Ctx) {
  const scope = await engScope("crm", false);
  if (isResponse(scope)) return scope;
  const s = await getSurvey(scope.dataId, (await ctx.params).id);
  return s ? NextResponse.json({ survey: s }) : NextResponse.json({ error: "not_found" }, { status: 404 });
}

export async function PATCH(req: NextRequest, ctx: Ctx) {
  const scope = await engScope("crm", true);
  if (isResponse(scope)) return scope;
  const limited = await writeLimit(scope, "surveys");
  if (limited) return limited;
  const b = await body(req, SurveyInputSchema.innerType().partial().strict());
  if (!b.ok) return b.res;
  try {
    const id = (await ctx.params).id;
    const s = await updateSurvey(scope.dataId, id, b.data);
    await recordAudit(scope, { action: "survey.update", entity: "survey", entityId: id, after: { fields: Object.keys(b.data) } });
    return NextResponse.json({ survey: s });
  } catch (err) {
    return fail(err, "engagement.surveys.PATCH");
  }
}
