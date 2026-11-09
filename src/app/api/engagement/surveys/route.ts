import { NextRequest, NextResponse } from "next/server";
import { recordAudit } from "@/lib/audit";
import { body, engScope, fail, gate, isResponse, writeLimit } from "@/lib/engagement/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
import { SurveyInputSchema, createSurvey, listSurveys } from "@/lib/engagement/surveys";

export async function GET() {
  const scope = await engScope("crm", false);
  if (isResponse(scope)) return scope;
  try {
    return NextResponse.json({ surveys: await listSurveys(scope.dataId) });
  } catch (err) {
    return fail(err, "engagement.surveys.GET");
  }
}

export async function POST(req: NextRequest) {
  const scope = await engScope("crm", true);
  if (isResponse(scope)) return scope;
  const limited = await writeLimit(scope, "surveys");
  if (limited) return limited;
  const blocked = await gate(scope, "surveys");
  if (blocked) return blocked;
  const b = await body(req, SurveyInputSchema);
  if (!b.ok) return b.res;
  try {
    const s = await createSurvey(scope.dataId, b.data);
    await recordAudit(scope, { action: "survey.create", entity: "survey", entityId: s.id, after: { name: s.name, kind: s.kind } });
    return NextResponse.json({ survey: s }, { status: 201 });
  } catch (err) {
    return fail(err, "engagement.surveys.POST");
  }
}
