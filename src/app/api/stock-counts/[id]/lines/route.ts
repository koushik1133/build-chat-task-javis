import { NextResponse, type NextRequest } from "next/server";
import { paramId, parseBody } from "@/lib/money/http";
import { CountLinesSchema, saveCountLines } from "@/lib/inventory/counts";
import { inventoryErrorResponse, inventoryGuard } from "@/lib/inventory/http";

export const runtime = "nodejs";

/** POST {lines:[{product_id, counted_qty|null}]} — record counted quantities. */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const g = await inventoryGuard(req, { edit: true, bucket: "cnt.write" });
  if (!g.ok) return g.res;
  try {
    const body = await parseBody(req, CountLinesSchema, 200_000);
    if (!body.ok) return body.res;
    const count = await saveCountLines(g.scope.dataId, await paramId(ctx), body.data);
    return NextResponse.json({ count });
  } catch (err) {
    return inventoryErrorResponse(err, "stock-counts.lines.POST");
  }
}
