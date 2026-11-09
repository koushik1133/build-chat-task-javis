import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { recordAudit } from "@/lib/audit";
import { body, engScope, fail, gate, isResponse, limitParam, writeLimit } from "@/lib/engagement/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
import { listResponses, promoteResponse } from "@/lib/engagement/reviews";

export async function GET(req: NextRequest) {
  const scope = await engScope("crm", false);
  if (isResponse(scope)) return scope;
  try {
    return NextResponse.json({ responses: await listResponses(scope.dataId, { surveyId: req.nextUrl.searchParams.get("survey_id"), limit: limitParam(req) }) });
  } catch (err) {
    return fail(err, "engagement.responses.GET");
  }
}

const Patch = z.object({ id: z.string().min(1).max(100), action: z.literal("publish"), quote: z.string().trim().max(1000).optional(), featured: z.boolean().optional() }).strict();

/** PATCH { id, action: "publish" } promotes a response (with the customer's public-display consent) to a published testimonial. */
export async function PATCH(req: NextRequest) {
  const scope = await engScope("crm", true);
  if (isResponse(scope)) return scope;
  const limited = await writeLimit(scope, "responses");
  if (limited) return limited;
  const blocked = await gate(scope, "surveys");
  if (blocked) return blocked;
  const b = await body(req, Patch);
  if (!b.ok) return b.res;
  try {
    const t = await promoteResponse(scope.dataId, b.data.id, { quote: b.data.quote, publish: true, featured: b.data.featured });
    await recordAudit(scope, { action: "testimonial.publish", entity: "testimonial", entityId: t.id, after: { response_id: b.data.id } });
    return NextResponse.json({ testimonial: t });
  } catch (err) {
    return fail(err, "engagement.responses.PATCH");
  }
}
