import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireScope } from "@/lib/auth/scope";
import { deleteCategory, listCategories, upsertCategory } from "@/lib/kb/articles";
import { errorResponse, parseBody } from "@/lib/money/http";

export const runtime = "nodejs";

const CategorySchema = z
  .object({
    name: z.string().min(1).max(100),
    slug: z.string().max(60).optional(),
    sort: z.number().int().min(0).max(10_000).optional(),
  })
  .strict();

export async function GET() {
  try {
    const scope = await requireScope({ area: "knowledge" });
    return NextResponse.json({ categories: await listCategories(scope.dataId) });
  } catch (err) {
    return errorResponse(err, "kb.categories.GET");
  }
}

export async function POST(req: NextRequest) {
  try {
    const scope = await requireScope({ area: "knowledge", edit: true });
    const body = await parseBody(req, CategorySchema);
    if (!body.ok) return body.res;
    const category = await upsertCategory(scope.dataId, body.data);
    return NextResponse.json({ category }, { status: 201 });
  } catch (err) {
    return errorResponse(err, "kb.categories.POST");
  }
}

/** DELETE /api/kb/categories?id= */
export async function DELETE(req: NextRequest) {
  try {
    const scope = await requireScope({ area: "knowledge", edit: true });
    const id = req.nextUrl.searchParams.get("id");
    if (!id) return NextResponse.json({ error: "id_required" }, { status: 400 });
    await deleteCategory(scope.dataId, id);
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return errorResponse(err, "kb.categories.DELETE");
  }
}
