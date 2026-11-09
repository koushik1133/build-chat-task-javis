import { NextResponse, type NextRequest } from "next/server";
import { rateLimitAsync } from "@/lib/request-limits";
import { resolveShareToken } from "@/lib/share-tokens";
import { getAttachment, openAttachment, portalAttachmentsForContact } from "@/lib/attachments/store";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ token: string }> };

function ip(req: NextRequest): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "anon";
}

/**
 * GET /api/p/portal/[token]/attachments — portal-visible files on the contact's entities.
 * With `?id=<attachment>` it opens one file (302 to a signed URL, or streams in dev mode)
 * after checking the file belongs to one of this contact's entities.
 */
export async function GET(req: NextRequest, ctx: Ctx) {
  if (!(await rateLimitAsync(`portal:files:${ip(req)}`, 60, 60_000)).allowed) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  try {
    const { token } = await ctx.params;
    const t = await resolveShareToken("portal", token);
    if (!t) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const files = await portalAttachmentsForContact(t.user_id, t.entity_id);
    const id = new URL(req.url).searchParams.get("id");
    if (!id) return NextResponse.json({ attachments: files });
    if (!files.some((f) => f.id === id)) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const a = await getAttachment(t.user_id, id);
    const opened = a ? await openAttachment(t.user_id, id) : null;
    if (!a || !opened) return NextResponse.json({ error: "not_found" }, { status: 404 });
    if (opened.url) return NextResponse.redirect(opened.url, { status: 302, headers: { "Cache-Control": "private, no-store" } });
    const safe = a.file_name.replace(/[^A-Za-z0-9._-]/g, "_");
    return new Response(new Uint8Array(opened.bytes ?? Buffer.alloc(0)), {
      status: 200,
      headers: { "Content-Type": a.content_type, "Content-Disposition": `attachment; filename="${safe}"`, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" },
    });
  } catch (err) {
    console.error("[portal] attachments failed:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
