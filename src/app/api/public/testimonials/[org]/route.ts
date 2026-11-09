import { NextRequest, NextResponse } from "next/server";
import { publicTestimonials } from "@/lib/engagement/reviews";
import { clientIp, rateLimitAsync } from "@/lib/request-limits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/public/testimonials/[org] -> published testimonials for embedding (CORS-open, cacheable). */
export async function GET(req: NextRequest, ctx: { params: Promise<{ org: string }> }) {
  if (!(await rateLimitAsync(`testimonials:${clientIp(req)}`, 120, 60_000)).allowed) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  try {
    const data = await publicTestimonials((await ctx.params).org);
    if (!data) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json(data, { headers: { "Cache-Control": "public, max-age=300, s-maxage=300", "Access-Control-Allow-Origin": "*" } });
  } catch (err) {
    console.error("[testimonials] GET failed:", err);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
