import { NextResponse, type NextRequest } from "next/server";
import { requireScope } from "@/lib/auth/scope";
import { getListing, listReviews } from "@/lib/marketplace/catalog";
import { errorResponse, paramId } from "@/lib/money/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const scope = await requireScope({ area: "agents" });
    const id = decodeURIComponent(await paramId(ctx));
    const listing = await getListing(scope.dataId, id);
    if (!listing) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const reviews = await listReviews(scope.dataId, listing.id, 50);
    return NextResponse.json({ listing, reviews });
  } catch (err) {
    return errorResponse(err, "marketplace.id.GET");
  }
}
