import { NextResponse, type NextRequest } from "next/server";
import { requireScope } from "@/lib/auth/scope";
import { searchArticles } from "@/lib/kb/search";
import { errorResponse } from "@/lib/money/http";

export const runtime = "nodejs";

/** GET /api/kb/search?q=&limit=&all=1 (all = include drafts) */
export async function GET(req: NextRequest) {
  try {
    const scope = await requireScope({ area: "knowledge" });
    const sp = req.nextUrl.searchParams;
    const q = sp.get("q")?.trim() ?? "";
    if (!q) return NextResponse.json({ hits: [] });
    const limit = Math.min(Math.max(Number(sp.get("limit") ?? 10) || 10, 1), 50);
    const hits = await searchArticles(scope.dataId, q, limit, { publishedOnly: sp.get("all") !== "1" });
    return NextResponse.json({ hits });
  } catch (err) {
    return errorResponse(err, "kb.search.GET");
  }
}
