import { NextResponse, type NextRequest } from "next/server";
import { requireScope } from "@/lib/auth/scope";
import { createArticle, listArticles, listCategories } from "@/lib/kb/articles";
import { ArticleBodySchema } from "@/lib/kb/http";
import { errorResponse, parseBody } from "@/lib/money/http";

export const runtime = "nodejs";

/** GET /api/kb/articles?status=&category=&q= — articles + categories. */
export async function GET(req: NextRequest) {
  try {
    const scope = await requireScope({ area: "knowledge" });
    const sp = req.nextUrl.searchParams;
    const [articles, categories] = await Promise.all([
      listArticles(scope.dataId, { status: sp.get("status"), category: sp.get("category"), q: sp.get("q"), limit: 200 }),
      listCategories(scope.dataId),
    ]);
    return NextResponse.json({ articles, categories });
  } catch (err) {
    return errorResponse(err, "kb.articles.GET");
  }
}

/** POST /api/kb/articles */
export async function POST(req: NextRequest) {
  try {
    const scope = await requireScope({ area: "knowledge", edit: true });
    const body = await parseBody(req, ArticleBodySchema, 256_000);
    if (!body.ok) return body.res;
    const article = await createArticle(scope.dataId, body.data);
    return NextResponse.json({ article }, { status: 201 });
  } catch (err) {
    return errorResponse(err, "kb.articles.POST");
  }
}
