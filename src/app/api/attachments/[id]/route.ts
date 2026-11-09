import { NextResponse, type NextRequest } from "next/server";
import { requireScope, scopeErrorResponse, type Scope } from "@/lib/auth/scope";
import { errorResponse } from "@/lib/money/http";
import { deleteAttachment, getAttachment, openAttachment } from "@/lib/attachments/store";
import { AREA_FOR_ENTITY } from "@/lib/attachments/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/attachments/[id] — 302 to a 10-minute signed URL (or streams the bytes in local dev mode). */
export async function GET(_req: NextRequest, ctx: Ctx) {
  let scope: Scope;
  try {
    scope = await requireScope();
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const { id } = await ctx.params;
    const a = await getAttachment(scope.dataId, id);
    if (!a) return NextResponse.json({ error: "not_found" }, { status: 404 });
    if (!scope.can(AREA_FOR_ENTITY[a.entity_kind], false)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
    const opened = await openAttachment(scope.dataId, id);
    if (!opened) return NextResponse.json({ error: "not_found" }, { status: 404 });
    if (opened.url) return NextResponse.redirect(opened.url, { status: 302, headers: { "Cache-Control": "private, no-store" } });
    const safe = a.file_name.replace(/[^A-Za-z0-9._-]/g, "_");
    return new Response(new Uint8Array(opened.bytes ?? Buffer.alloc(0)), {
      status: 200,
      headers: {
        "Content-Type": a.content_type,
        "Content-Length": String(opened.bytes?.byteLength ?? 0),
        "Content-Disposition": `attachment; filename="${safe}"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "X-Attachment-SHA256": a.sha256,
      },
    });
  } catch (err) {
    return errorResponse(err, "attachments.id.GET");
  }
}

/** DELETE /api/attachments/[id] — soft delete. */
export async function DELETE(_req: NextRequest, ctx: Ctx) {
  let scope: Scope;
  try {
    scope = await requireScope();
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const { id } = await ctx.params;
    const a = await getAttachment(scope.dataId, id);
    if (!a) return NextResponse.json({ error: "not_found" }, { status: 404 });
    if (!scope.can(AREA_FOR_ENTITY[a.entity_kind], true)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
    await deleteAttachment(scope.dataId, id, scope.userId);
    return NextResponse.json({ ok: true, id });
  } catch (err) {
    return errorResponse(err, "attachments.id.DELETE");
  }
}
