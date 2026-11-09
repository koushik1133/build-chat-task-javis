import { NextRequest, NextResponse } from "next/server";
import { engScope, fail, isResponse } from "@/lib/engagement/http";
import { surveyResults } from "@/lib/engagement/surveys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const scope = await engScope("crm", false);
  if (isResponse(scope)) return scope;
  try {
    const days = Math.min(Math.max(Number(req.nextUrl.searchParams.get("days")) || 90, 1), 730);
    const r = await surveyResults(scope.dataId, (await ctx.params).id, { days });
    return r ? NextResponse.json(r) : NextResponse.json({ error: "not_found" }, { status: 404 });
  } catch (err) {
    return fail(err, "engagement.results.GET");
  }
}
