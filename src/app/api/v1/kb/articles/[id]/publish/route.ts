import { getArticle, updateArticle } from "@/lib/kb/articles";
import { ROUTES } from "@/lib/public-api/registry";
import { op, libCall, mustFind } from "@/lib/public-api/handler";
import { kbArticleView } from "@/lib/public-api/views";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = op(ROUTES.publishKbArticle, async ({ principal, params }) => {
  const existing = mustFind(await getArticle(principal.dataId, params.id), "Article");
  if (existing.status === "published") return { data: kbArticleView(existing) };
  return { data: kbArticleView(await libCall(() => updateArticle(principal.dataId, params.id, { status: "published" }))) };
});
