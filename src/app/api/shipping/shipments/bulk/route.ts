import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireScope } from "@/lib/auth/scope";
import { parseBody } from "@/lib/money/http";
import { planGate } from "@/lib/plans/http";
import { shippingError } from "@/lib/shipping/http";
 import { bulkCreateShipments, BULK_LIMIT } from "@/lib/shipping/shipments";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({ order_ids: z.array(z.string().min(1).max(100)).min(1).max(BULK_LIMIT), provider: z.enum(["simulated", "easypost", "shippo"]).optional() }).strict();

/** POST /api/shipping/shipments/bulk — create shipments for up to 50 paid orders; per-order results. */
export async function POST(req: NextRequest) {
  try {
    const scope = await requireScope({ area: "billing", edit: true });
    const body = await parseBody(req, Body);
    if (!body.ok) return body.res;
    const gate = await planGate(scope, { feature: "shipping" });
    if (gate) return gate;
    const results = await bulkCreateShipments(scope.dataId, body.data.order_ids, { provider: body.data.provider }, { actorId: scope.userId });
    return NextResponse.json({ results, created: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length });
  } catch (err) {
    return shippingError(err, "shipping.shipments.bulk");
  }
}
