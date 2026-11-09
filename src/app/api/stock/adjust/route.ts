import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { parseBody } from "@/lib/money/http";
import { adjustStock } from "@/lib/inventory/stock";
import { inventoryErrorResponse, inventoryGuard } from "@/lib/inventory/http";

export const runtime = "nodejs";

const Body = z
  .object({
    product_id: z.string().min(1).max(100),
    location_id: z.string().min(1).max(100).nullable().optional(),
    kind: z.enum(["receive", "consume", "adjust"]),
    qty: z.number().int().min(-100_000_000).max(100_000_000),
    note: z.string().trim().max(500).nullable().optional(),
  })
  .strict();

/** POST /api/stock/adjust {product_id, location_id?, kind, qty, note?} */
export async function POST(req: NextRequest) {
  const g = await inventoryGuard(req, { edit: true, bucket: "adjust" });
  if (!g.ok) return g.res;
  try {
    const body = await parseBody(req, Body);
    if (!body.ok) return body.res;
    const { product_id, ...input } = body.data;
    const product = await adjustStock(g.scope.dataId, product_id, input, g.scope.userId);
    return NextResponse.json({ product });
  } catch (err) {
    return inventoryErrorResponse(err, "stock.adjust.POST");
  }
}
