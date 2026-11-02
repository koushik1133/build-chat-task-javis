import { NextRequest, NextResponse } from "next/server";
import { getHelpCenterOrg, listPublicArticles } from "@/lib/kb/articles";
import { searchArticles } from "@/lib/kb/search";
import { publicRateLimit } from "@/lib/money/http";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ org: string }> };

/** GET /api/help/[org]?q=&category= — published, public articles + categories. */
export async function GET(req: NextRequest, ctx: Ctx) {
  const limited = publicRateLimit(req, "help", 120);
  if (limited) return limited;
  try {
    const { org: orgSlug } = await ctx.params;
    const org = await getHelpCenterOrg(orgSlug);
    if (!org) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const q = req.nextUrl.searchParams.get("q")?.trim() ?? "";
    const category = req.nextUrl.searchParams.get("category");
    if (q) {
      const [hits, base] = await Promise.all([
        searchArticles(org.dataId, q, 25, { publicOnly: true }),
        listPublicArticles(org.dataId, { category }),
      ]);
      return NextResponse.json({
        org: { name: org.name, slug: org.slug },
        articles: hits
          .filter((h) => !category || h.category === category)
          .map((h) => ({ id: h.id, slug: h.slug, title: h.title, excerpt: h.excerpt, category: h.category, tags: h.tags, views: h.views, published_at: h.published_at, updated_at: h.updated_at, score: h.score, snippet: h.snippet })),
        categories: base.categories,
        q,
      });
    }
    const data = await listPublicArticles(org.dataId, { category });
    return NextResponse.json({ org: { name: org.name, slug: org.slug }, ...data, q: "" });
  } catch (err) {
    console.error("[help] GET failed:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
