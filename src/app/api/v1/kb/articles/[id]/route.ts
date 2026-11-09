import { getArticle, updateArticle } from "@/lib/kb/articles";
import { ROUTES } from "@/lib/public-api/registry";
import { op, libCall, mustFind } from "@/lib/public-api/handler";
import { kbArticleView } from "@/lib/public-api/views";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = op(ROUTES.getKbArticle, async ({ principal, params }) => ({ data: kbArticleView(mustFind(await getArticle(principal.dataId, params.id), "Article")) }));

export const PATCH = op(ROUTES.updateKbArticle, async ({ principal, params, body }) => {
  mustFind(await getArticle(principal.dataId, params.id), "Article");
  return { data: kbArticleView(await libCall(() => updateArticle(principal.dataId, params.id, body))) };
});
