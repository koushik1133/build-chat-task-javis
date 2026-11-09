import { searchArticles } from "@/lib/kb/search";
import { ROUTES } from "@/lib/public-api/registry";
import { op, singlePage } from "@/lib/public-api/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = op(ROUTES.searchKb, async ({ principal, query }) => {
  const hits = await searchArticles(principal.dataId, query.q, query.limit ?? 10, { publishedOnly: query.drafts !== "true" });
  return singlePage(hits.map((h) => ({ id: h.id, slug: h.slug, title: h.title, excerpt: h.excerpt, category: h.category, status: h.status, is_public: h.is_public, score: h.score, snippet: h.snippet })));
});
