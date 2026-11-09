import { createArticle, listArticles } from "@/lib/kb/articles";
import { ROUTES } from "@/lib/public-api/registry";
import { op, libCall, singlePage } from "@/lib/public-api/handler";
import { kbArticleView } from "@/lib/public-api/views";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = op(ROUTES.listKbArticles, async ({ principal, query, list }) =>
  singlePage(
    (await listArticles(principal.dataId, { status: query.status ?? null, category: query.category ?? null, q: query.q ?? list.q, publicOnly: query.public === "true", limit: list.limit })).map(kbArticleView)
  )
);

export const POST = op(ROUTES.createKbArticle, async ({ principal, body }) => ({ data: kbArticleView(await libCall(() => createArticle(principal.dataId, body))), status: 201 }));
