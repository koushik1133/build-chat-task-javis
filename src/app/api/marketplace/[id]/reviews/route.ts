import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireScope } from "@/lib/auth/scope";
import { addReview, getListing, listReviews } from "@/lib/marketplace/catalog";
import { errorResponse, paramId, parseBody } from "@/lib/money/http";
import { rateLimit } from "@/lib/request-limits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({ rating: z.number().int().min(1).max(5), body: z.string().trim().max(2000).nullable().optional() }).strict();

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const scope = await requireScope({ area: "agents" });
    const id = decodeURIComponent(await paramId(ctx));
    const listing = await getListing(scope.dataId, id);
    if (!listing) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const reviews = await listReviews(scope.dataId, listing.id, 100);
    return NextResponse.json({ reviews });
  } catch (err) {
    return errorResponse(err, "marketplace.id.reviews.GET");
  }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const scope = await requireScope({ area: "agents", edit: true });
    if (!rateLimit(`marketplace-review:${scope.dataId}`, 20, 60 * 60 * 1000).allowed) {
      return NextResponse.json({ error: "rate_limited", detail: "Too many reviews; try again later." }, { status: 429 });
    }
    const id = decodeURIComponent(await paramId(ctx));
    const body = await parseBody(req, Body, 8_192);
    if (!body.ok) return body.res;
    const review = await addReview(scope.dataId, id, body.data.rating, body.data.body ?? null);
    const listing = await getListing(scope.dataId, id);
    return NextResponse.json({ review, listing }, { status: 201 });
  } catch (err) {
    return errorResponse(err, "marketplace.id.reviews.POST");
  }
}
