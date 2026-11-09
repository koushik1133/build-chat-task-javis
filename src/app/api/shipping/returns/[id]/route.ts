import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireScope } from "@/lib/auth/scope";
import { parseBody, paramId } from "@/lib/money/http";
import { planGate } from "@/lib/plans/http";
import { shippingError } from "@/lib/shipping/http";
 import { closeReturn, decideReturn, getReturn, markReturnReceived, refundReturn, sendReturnLabel } from "@/lib/shipping/returns";
import { listShipments } from "@/lib/shipping/shipments";
import { RETURN_RESOLUTIONS } from "@/lib/shipping/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, ctx: Ctx) {
  try {
    const scope = await requireScope({ area: "billing", edit: false });
    const id = await paramId(ctx);
    const ret = await getReturn(scope.dataId, id);
    if (!ret) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ return: ret, shipments: await listShipments(scope.dataId, { returnId: id, limit: 10 }) });
  } catch (err) {
    return shippingError(err, "shipping.return.GET");
  }
}

const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("approve"), notes: z.string().trim().max(1000).optional(), resolution: z.enum(RETURN_RESOLUTIONS).optional() }).strict(),
  z.object({ action: z.literal("reject"), notes: z.string().trim().max(1000).optional() }).strict(),
  z.object({ action: z.literal("label"), provider: z.enum(["simulated", "easypost", "shippo"]).optional(), instructions: z.string().trim().max(2000).optional(), manual: z.object({ carrier: z.string().trim().min(1).max(80), tracking_number: z.string().trim().max(120).optional(), tracking_url: z.string().trim().max(2048).optional() }).strict().optional() }).strict(),
  z.object({ action: z.literal("receive"), restock: z.boolean().optional() }).strict(),
  z.object({ action: z.literal("refund"), amount_minor: z.number().int().min(0).max(1_000_000_000).optional(), resolution: z.enum(RETURN_RESOLUTIONS).optional() }).strict(),
  z.object({ action: z.literal("close") }).strict(),
]);

/** POST /api/shipping/returns/[id] — { action: approve | reject | label | receive | refund | close, ... } */
export async function POST(req: NextRequest, ctx: Ctx) {
  try {
    const scope = await requireScope({ area: "billing", edit: true });
    const body = await parseBody(req, Body);
    if (!body.ok) return body.res;
    const id = await paramId(ctx);
    const b = body.data;
    const actorId = scope.userId;
    switch (b.action) {
      case "approve":
      case "reject":
        return NextResponse.json({ return: await decideReturn(scope.dataId, id, b.action, { notes: b.notes, resolution: b.action === "approve" ? b.resolution : undefined, actorId }) });
      case "label": {
        if (!b.manual && !(b.instructions && !b.provider)) {
          const gate = await planGate(scope, { feature: "shipping" });
          if (gate) return gate;
        }
        const r = await sendReturnLabel(scope.dataId, id, { provider: b.provider, manual: b.manual, instructions: b.instructions, actorId });
        return NextResponse.json({ return: r.ret, shipment: r.shipment });
      }
      case "receive":
        return NextResponse.json({ return: await markReturnReceived(scope.dataId, id, { restock: b.restock, actorId }) });
      case "refund": {
        const r = await refundReturn(scope.dataId, id, { amount_minor: b.amount_minor, resolution: b.resolution, actorId });
        return NextResponse.json({ return: r.ret, refunded_minor: r.refunded_minor });
      }
      case "close":
        return NextResponse.json({ return: await closeReturn(scope.dataId, id) });
    }
  } catch (err) {
    return shippingError(err, "shipping.return.POST");
  }
}
