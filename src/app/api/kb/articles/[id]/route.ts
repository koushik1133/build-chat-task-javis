import { NextResponse, type NextRequest } from "next/server";
import { requireScope } from "@/lib/auth/scope";
import { deleteArticle, getArticle, updateArticle } from "@/lib/kb/articles";
import { ArticlePatchSchema } from "@/lib/kb/http";
import { errorResponse, parseBody } from "@/lib/money/http";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, ctx: Ctx) {
  try {
    const scope = await requireScope({ area: "knowledge" });
    const { id } = await ctx.params;
    const article = await getArticle(scope.dataId, id);
    if (!article) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ article });
  } catch (err) {
    return errorResponse(err, "kb.article.GET");
  }
}

export async function PATCH(req: NextRequest, ctx: Ctx) {
  try {
    const scope = await requireScope({ area: "knowledge", edit: true });
    const { id } = await ctx.params;
    const body = await parseBody(req, ArticlePatchSchema, 256_000);
    if (!body.ok) return body.res;
    if (!(await getArticle(scope.dataId, id))) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const article = await updateArticle(scope.dataId, id, body.data);
    return NextResponse.json({ article });
  } catch (err) {
    return errorResponse(err, "kb.article.PATCH");
  }
}

export async function DELETE(_req: NextRequest, ctx: Ctx) {
  try {
    const scope = await requireScope({ area: "knowledge", edit: true });
    const { id } = await ctx.params;
    const ok = await deleteArticle(scope.dataId, id);
    if (!ok) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return errorResponse(err, "kb.article.DELETE");
  }
}
