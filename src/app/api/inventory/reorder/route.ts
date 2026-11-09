import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireScope } from "@/lib/auth/scope";
import { parseBody } from "@/lib/money/http";
import { financeErrorResponse } from "@/lib/finance/http";
import { rateLimitAsync } from "@/lib/request-limits";
import { createReorderPurchaseOrders, reorderSuggestions } from "@/lib/procurement/reorder";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/inventory/reorder — low-stock products with suggested quantities, grouped by preferred supplier. */
export async function GET() {
  try {
    const scope = await requireScope({ area: "billing" });
    return NextResponse.json(await reorderSuggestions(scope.dataId));
  } catch (err) {
    return financeErrorResponse(err, "inventory.reorder.GET");
  }
}

const CreateSchema = z.object({ product_ids: z.array(z.string().min(1).max(100)).max(500).optional() }).strict();

/** POST /api/inventory/reorder { product_ids? } — one draft PO per supplier. */
export async function POST(req: NextRequest) {
  try {
    const scope = await requireScope({ area: "billing", edit: true });
    const rl = await rateLimitAsync(`reorder:create:${scope.dataId}`, 30, 60_000);
    if (!rl.allowed) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
    const body = await parseBody(req, CreateSchema);
    if (!body.ok) return body.res;
    const out = await createReorderPurchaseOrders(scope.dataId, { productIds: body.data.product_ids ?? null }, scope.userId);
    return NextResponse.json({ purchase_orders: out.created, skipped: out.skipped }, { status: 201 });
  } catch (err) {
    return financeErrorResponse(err, "inventory.reorder.POST");
  }
}
