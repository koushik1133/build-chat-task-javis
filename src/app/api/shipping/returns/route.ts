import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireScope } from "@/lib/auth/scope";
import { parseBody } from "@/lib/money/http";
import { shippingError } from "@/lib/shipping/http";
 import { createReturnRequest, listReturns, ReturnRequestSchema } from "@/lib/shipping/returns";
import { RETURN_STATUSES } from "@/lib/shipping/types";
import { decodeCursor } from "@/lib/public-api/pagination";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const scope = await requireScope({ area: "billing", edit: false });
    const sp = req.nextUrl.searchParams;
    const st = sp.get("status");
    const limit = Math.min(Math.max(Number(sp.get("limit")) || 50, 1), 200);
    const rows = await listReturns(scope.dataId, { status: st && (RETURN_STATUSES as readonly string[]).includes(st) ? (st as (typeof RETURN_STATUSES)[number]) : null, orderId: sp.get("order_id"), cursor: decodeCursor(sp.get("cursor")), limit: limit + 1 });
    const more = rows.length > limit;
    const data = more ? rows.slice(0, limit) : rows;
    const last = data[data.length - 1];
    return NextResponse.json({ returns: data, next_cursor: more && last ? Buffer.from(`${last.created_at}|${last.id}`).toString("base64url") : null });
  } catch (err) {
    return shippingError(err, "shipping.returns.GET");
  }
}

const Body = ReturnRequestSchema.extend({ order_id: z.string().min(1).max(100) });

/** POST /api/shipping/returns — staff opens a return on a customer's behalf. */
export async function POST(req: NextRequest) {
  try {
    const scope = await requireScope({ area: "billing", edit: true });
    const body = await parseBody(req, Body);
    if (!body.ok) return body.res;
    const { order_id, ...input } = body.data;
    return NextResponse.json({ return: await createReturnRequest(scope.dataId, order_id, input, { source: "staff", actorId: scope.userId }) }, { status: 201 });
  } catch (err) {
    return shippingError(err, "shipping.returns.POST");
  }
}
