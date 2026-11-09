import { NextResponse, type NextRequest } from "next/server";
import { requireScope } from "@/lib/auth/scope";
import { paramId, parseBody, SendBodySchema } from "@/lib/money/http";
import { financeErrorResponse } from "@/lib/finance/http";
import { rateLimitAsync } from "@/lib/request-limits";
import { sendPurchaseOrder } from "@/lib/procurement/purchase-orders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const scope = await requireScope({ area: "billing", edit: true });
    const rl = await rateLimitAsync(`po:send:${scope.dataId}`, 60, 60_000);
    if (!rl.allowed) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
    const body = await parseBody(req, SendBodySchema.strict());
    if (!body.ok) return body.res;
    const out = await sendPurchaseOrder(scope.dataId, await paramId(ctx), body.data);
    return NextResponse.json({ purchase_order: out.purchaseOrder, to: out.to });
  } catch (err) {
    return financeErrorResponse(err, "purchase-orders.id.send.POST");
  }
}
