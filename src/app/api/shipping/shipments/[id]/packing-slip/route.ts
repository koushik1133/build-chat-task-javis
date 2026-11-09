import { NextResponse, type NextRequest } from "next/server";
import { requireScope } from "@/lib/auth/scope";
import { paramId } from "@/lib/money/http";
import { shippingError } from "@/lib/shipping/http";
 import { renderPackingSlipFor } from "@/lib/shipping/shipments";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/shipping/shipments/[id]/packing-slip — PDF. */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const scope = await requireScope({ area: "billing", edit: false });
    const { bytes, fileName } = await renderPackingSlipFor(scope.dataId, await paramId(ctx));
    return new NextResponse(new Uint8Array(bytes), { headers: { "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="${fileName}"`, "Cache-Control": "private, no-store" } });
  } catch (err) {
    return shippingError(err, "shipping.shipment.slip");
  }
}
