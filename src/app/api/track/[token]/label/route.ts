import { NextResponse, type NextRequest } from "next/server";
import { openAttachment } from "@/lib/attachments/store";
import { publicRateLimit } from "@/lib/money/http";
import { resolveShareToken } from "@/lib/share-tokens";
import { getShipment } from "@/lib/shipping/shipments";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/track/[token]/label — the customer downloads their RETURN label (shipment token only; outbound labels are never public). */
export async function GET(req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const limited = await publicRateLimit(req, "track-label", 30);
  if (limited) return limited;
  try {
    const share = await resolveShareToken("shipment", (await ctx.params).token);
    if (!share) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const s = await getShipment(share.user_id, share.entity_id);
    if (!s || !s.return_id || s.status === "void") return NextResponse.json({ error: "not_found" }, { status: 404 });
    if (s.label_url) return NextResponse.redirect(s.label_url, 302);
    if (!s.label_attachment_id) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const opened = await openAttachment(share.user_id, s.label_attachment_id);
    if (!opened?.bytes) return opened?.url ? NextResponse.redirect(opened.url, 302) : NextResponse.json({ error: "not_found" }, { status: 404 });
    return new NextResponse(new Uint8Array(opened.bytes), { headers: { "Content-Type": "application/pdf", "Content-Disposition": 'inline; filename="return-label.pdf"', "Cache-Control": "private, no-store" } });
  } catch (err) {
    console.error("[track.label]", err);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
