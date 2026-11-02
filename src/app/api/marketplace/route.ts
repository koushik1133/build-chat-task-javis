import { NextResponse, type NextRequest } from "next/server";
import { requireScope } from "@/lib/auth/scope";
import { listCatalog } from "@/lib/marketplace/catalog";
import { isListingKind, SORTS, type Sort } from "@/lib/marketplace/types";
import { errorResponse } from "@/lib/money/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Catalog: built-ins + public listings + the caller's own. Authenticated
 * (area "agents", view) because the response includes the org's private
 * listings and install state — anonymous callers get 401.
 */
export async function GET(req: NextRequest) {
  try {
    const scope = await requireScope({ area: "agents" });
    const sp = req.nextUrl.searchParams;
    const kindRaw = sp.get("kind");
    const sortRaw = sp.get("sort");
    const listings = await listCatalog(scope.dataId, {
      q: sp.get("q")?.slice(0, 200) ?? null,
      kind: isListingKind(kindRaw) ? kindRaw : null,
      category: sp.get("category")?.slice(0, 40) || null,
      sort: (SORTS as readonly string[]).includes(sortRaw ?? "") ? (sortRaw as Sort) : null,
      limit: Number(sp.get("limit")) || null,
    });
    return NextResponse.json({ listings });
  } catch (err) {
    return errorResponse(err, "marketplace.GET");
  }
}
