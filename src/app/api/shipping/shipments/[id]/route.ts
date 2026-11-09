import { NextResponse, type NextRequest } from "next/server";
import { requireScope } from "@/lib/auth/scope";
import { paramId } from "@/lib/money/http";
import { shippingError } from "@/lib/shipping/http";
 import { getShipment, listShipmentEvents } from "@/lib/shipping/shipments";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/shipping/shipments/[id] — shipment + tracking timeline. */
export async function GET(_req: NextRequest, ctx: Ctx) {
  try {
    const scope = await requireScope({ area: "billing", edit: false });
    const shipment = await getShipment(scope.dataId, await paramId(ctx));
    if (!shipment) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ shipment, events: await listShipmentEvents(scope.dataId, shipment.id) });
  } catch (err) {
    return shippingError(err, "shipping.shipment.GET");
  }
}
