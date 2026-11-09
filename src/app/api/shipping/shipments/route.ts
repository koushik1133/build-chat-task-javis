import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireScope } from "@/lib/auth/scope";
import { parseBody } from "@/lib/money/http";
import { planGate } from "@/lib/plans/http";
import { shippingError } from "@/lib/shipping/http";
 import { listShipments, createShipmentForOrder, CreateShipmentSchema } from "@/lib/shipping/shipments";
import { SHIPMENT_STATUSES } from "@/lib/shipping/types";
import { decodeCursor } from "@/lib/public-api/pagination";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/shipping/shipments?status=&order_id=&q=&cursor= */
export async function GET(req: NextRequest) {
  try {
    const scope = await requireScope({ area: "billing", edit: false });
    const sp = req.nextUrl.searchParams;
    const status = sp.get("status");
    const limit = Math.min(Math.max(Number(sp.get("limit")) || 50, 1), 200);
    const rows = await listShipments(scope.dataId, {
      status: status && (SHIPMENT_STATUSES as readonly string[]).includes(status) ? (status as (typeof SHIPMENT_STATUSES)[number]) : null,
      orderId: sp.get("order_id"),
      q: sp.get("q"),
      cursor: decodeCursor(sp.get("cursor")),
      limit: limit + 1,
    });
    const more = rows.length > limit;
    const data = more ? rows.slice(0, limit) : rows;
    const last = data[data.length - 1];
    return NextResponse.json({ shipments: data, next_cursor: more && last ? Buffer.from(`${last.created_at}|${last.id}`).toString("base64url") : null });
  } catch (err) {
    return shippingError(err, "shipping.shipments.GET");
  }
}

const Body = CreateShipmentSchema.extend({ order_id: z.string().min(1).max(100) });

/** POST /api/shipping/shipments — create shipment(s) for an order (buys a label unless `manual`). */
export async function POST(req: NextRequest) {
  try {
    const scope = await requireScope({ area: "billing", edit: true });
    const body = await parseBody(req, Body);
    if (!body.ok) return body.res;
    if (!body.data.manual) {
      const gate = await planGate(scope, { feature: "shipping" });
      if (gate) return gate;
    }
    const { order_id, ...input } = body.data;
    const shipments = await createShipmentForOrder(scope.dataId, order_id, input, { actorId: scope.userId });
    return NextResponse.json({ shipments }, { status: 201 });
  } catch (err) {
    return shippingError(err, "shipping.shipments.POST");
  }
}
