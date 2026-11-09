import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireScope } from "@/lib/auth/scope";
import { parseBody } from "@/lib/money/http";
import { shippingError } from "@/lib/shipping/http";
 import { ratesForOrder, PackageInputSchema } from "@/lib/shipping/shipments";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({ order_id: z.string().min(1).max(100), provider: z.enum(["simulated", "easypost", "shippo"]).optional(), package: PackageInputSchema.optional() }).strict();

/** POST /api/shipping/rates — carrier rates for an order (the rate picker); nothing is purchased. */
export async function POST(req: NextRequest) {
  try {
    const scope = await requireScope({ area: "billing", edit: true });
    const body = await parseBody(req, Body);
    if (!body.ok) return body.res;
    return NextResponse.json(await ratesForOrder(scope.dataId, body.data.order_id, { provider: body.data.provider, package: body.data.package }));
  } catch (err) {
    return shippingError(err, "shipping.rates");
  }
}
