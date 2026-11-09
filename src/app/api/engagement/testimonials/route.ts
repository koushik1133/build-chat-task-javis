import { NextRequest, NextResponse } from "next/server";
import { engScope, fail, isResponse, limitParam } from "@/lib/engagement/http";
import { listTestimonials } from "@/lib/engagement/reviews";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const scope = await engScope("crm", false);
  if (isResponse(scope)) return scope;
  try {
    return NextResponse.json({ testimonials: await listTestimonials(scope.dataId, { limit: limitParam(req, 100) }) });
  } catch (err) {
    return fail(err, "engagement.testimonials.GET");
  }
}
