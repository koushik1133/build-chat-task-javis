import { NextResponse, type NextRequest } from "next/server";
import { requireScope } from "@/lib/auth/scope";
import { paramId } from "@/lib/money/http";
import { shippingError } from "@/lib/shipping/http";
 import { getShipment } from "@/lib/shipping/shipments";
import { openAttachment } from "@/lib/attachments/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/shipping/shipments/[id]/label — the label PDF (redirects to a hosted carrier label when there is one). */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const scope = await requireScope({ area: "billing", edit: false });
    const s = await getShipment(scope.dataId, await paramId(ctx));
    if (!s) return NextResponse.json({ error: "not_found" }, { status: 404 });
    if (s.label_url) return NextResponse.redirect(s.label_url, 302);
    if (!s.label_attachment_id) return NextResponse.json({ error: "not_found", detail: "No label for this shipment" }, { status: 404 });
    const opened = await openAttachment(scope.dataId, s.label_attachment_id);
    if (!opened) return NextResponse.json({ error: "not_found" }, { status: 404 });
    if (opened.bytes) return new NextResponse(new Uint8Array(opened.bytes), { headers: { "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="label-${s.tracking_number ?? s.id}.pdf"`, "Cache-Control": "private, no-store" } });
    return opened.url ? NextResponse.redirect(opened.url, 302) : NextResponse.json({ error: "not_found" }, { status: 404 });
  } catch (err) {
    return shippingError(err, "shipping.shipment.label");
  }
}
