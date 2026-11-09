import { NextResponse, type NextRequest } from "next/server";
import { requireScope } from "@/lib/auth/scope";
import { paramId } from "@/lib/money/http";
import { shippingError } from "@/lib/shipping/http";
 import { voidShipment } from "@/lib/shipping/shipments";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/shipping/shipments/[id]/void — void an unused label (provider refund). */
export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const scope = await requireScope({ area: "billing", edit: true });
    return NextResponse.json({ shipment: await voidShipment(scope.dataId, await paramId(ctx), scope.userId) });
  } catch (err) {
    return shippingError(err, "shipping.shipment.void");
  }
}
