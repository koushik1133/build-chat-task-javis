import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireScope } from "@/lib/auth/scope";
import { parseBody, paramId } from "@/lib/money/http";
import { shippingError } from "@/lib/shipping/http";
 import { markShipped } from "@/lib/shipping/shipments";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({ carrier: z.string().trim().max(80).optional(), tracking_number: z.string().trim().max(120).optional(), tracking_url: z.string().trim().max(2048).optional() }).strict();

/** POST /api/shipping/shipments/[id]/ship — mark shipped manually (optionally set carrier/tracking). */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const scope = await requireScope({ area: "billing", edit: true });
    const body = await parseBody(req, Body);
    if (!body.ok) return body.res;
    return NextResponse.json({ shipment: await markShipped(scope.dataId, await paramId(ctx), body.data, scope.userId) });
  } catch (err) {
    return shippingError(err, "shipping.shipment.ship");
  }
}
