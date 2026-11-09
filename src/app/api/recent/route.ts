import { NextResponse } from "next/server";
import { z } from "zod";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { safeHref } from "@/lib/recent/pure";
import { listRecents, recordRecent } from "@/lib/recent/store";

export const runtime = "nodejs";

const Body = z
  .object({
    kind: z.string().trim().min(1).max(40),
    entity_id: z.string().trim().min(1).max(200),
    title: z.string().trim().min(1).max(200),
    href: z.string().max(500),
  })
  .strict();

/** GET /api/recent?limit=8 — the caller's most recently opened items. */
export async function GET(req: Request) {
  try {
    const scope = await requireScope();
    const limit = Number(new URL(req.url).searchParams.get("limit")) || 8;
    return NextResponse.json({ items: await listRecents(scope.dataId, scope.userId, limit) });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "Could not load recent items." }, { status: 500 });
  }
}

/** POST /api/recent — record that the caller opened an item (upsert, capped at 30 per member). */
export async function POST(req: Request) {
  try {
    const scope = await requireScope();
    const parsed = Body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "Invalid body" }, { status: 400 });
    const href = safeHref(parsed.data.href);
    if (!href) return NextResponse.json({ error: "href must be an app-relative path" }, { status: 400 });
    await recordRecent(scope.dataId, scope.userId, { kind: parsed.data.kind, entityId: parsed.data.entity_id, title: parsed.data.title, href });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "Could not record item." }, { status: 500 });
  }
}
