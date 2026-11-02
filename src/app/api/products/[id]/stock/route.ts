import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireScope } from "@/lib/auth/scope";
import { paramId, parseBody } from "@/lib/money/http";
import { financeErrorResponse } from "@/lib/finance/http";
import { adjustStock } from "@/lib/inventory/stock";

export const runtime = "nodejs";
type Ctx = { params: Promise<{ id: string }> };

const StockBody = z
  .object({
    kind: z.enum(["receive", "consume", "adjust"]),
    qty: z.number().int().min(-100_000_000).max(100_000_000),
    note: z.string().trim().max(500).nullable().optional(),
    ref_kind: z.string().trim().max(40).nullable().optional(),
    ref_id: z.string().trim().max(100).nullable().optional(),
  })
  .strict();

/** POST /api/products/[id]/stock {kind: receive|consume|adjust, qty, note} */
export async function POST(req: NextRequest, ctx: Ctx) {
  try {
    const scope = await requireScope({ area: "billing", edit: true });
    const body = await parseBody(req, StockBody);
    if (!body.ok) return body.res;
    const product = await adjustStock(scope.dataId, await paramId(ctx), body.data, scope.userId);
    return NextResponse.json({ product });
  } catch (err) {
    return financeErrorResponse(err, "products.id.stock.POST");
  }
}
