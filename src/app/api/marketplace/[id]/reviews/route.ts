import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireScope } from "@/lib/auth/scope";
import { addReview, getListing, listReviews } from "@/lib/marketplace/catalog";
import { errorResponse, paramId, parseBody } from "@/lib/money/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({ rating: z.number().int().min(1).max(5), body: z.string().trim().max(2000).nullable().optional() }).strict();

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const scope = await requireScope({ area: "agents" });
    const id = decodeURIComponent(await paramId(ctx));
    const reviews = await listReviews(scope.dataId, id, 100);
    return NextResponse.json({ reviews });
  } catch (err) {
    return errorResponse(err, "marketplace.id.reviews.GET");
  }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const scope = await requireScope({ area: "agents", edit: true });
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
