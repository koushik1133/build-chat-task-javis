import { NextResponse } from "next/server";
import { z } from "zod";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { safeHref } from "@/lib/recent/pure";
import { addFavorite, listFavorites, removeFavorite } from "@/lib/recent/store";

export const runtime = "nodejs";

const Body = z
  .object({
    kind: z.string().trim().min(1).max(40),
    entity_id: z.string().trim().min(1).max(200).nullish(),
    label: z.string().trim().min(1).max(200),
    href: z.string().max(500),
  })
  .strict();

/** GET /api/favorites — the caller's pinned pages and items. */
export async function GET() {
  try {
    const scope = await requireScope();
    return NextResponse.json({ favorites: await listFavorites(scope.dataId, scope.userId) });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "Could not load favourites." }, { status: 500 });
  }
}

/** POST /api/favorites — pin a page or entity (idempotent). */
export async function POST(req: Request) {
  try {
    const scope = await requireScope();
    const parsed = Body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "Invalid body" }, { status: 400 });
    const href = safeHref(parsed.data.href);
    if (!href) return NextResponse.json({ error: "href must be an app-relative path" }, { status: 400 });
    const out = await addFavorite(scope.dataId, scope.userId, { kind: parsed.data.kind, entityId: parsed.data.entity_id ?? null, label: parsed.data.label, href });
    if ("error" in out) return NextResponse.json({ error: "Too many pinned items (max 50)." }, { status: 409 });
    return NextResponse.json({ favorite: out.row }, { status: out.created ? 201 : 200 });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "Could not pin item." }, { status: 500 });
  }
}

/** DELETE /api/favorites?id= — unpin. */
export async function DELETE(req: Request) {
  try {
    const scope = await requireScope();
    const id = new URL(req.url).searchParams.get("id");
    if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
    const ok = await removeFavorite(scope.dataId, scope.userId, id);
    return ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "Not found" }, { status: 404 });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "Could not unpin item." }, { status: 500 });
  }
}
