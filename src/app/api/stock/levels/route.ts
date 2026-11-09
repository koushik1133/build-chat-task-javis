import { NextResponse, type NextRequest } from "next/server";
import { listLevels } from "@/lib/inventory/levels";
import { inventoryErrorResponse, inventoryGuard } from "@/lib/inventory/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/stock/levels?product=&location= */
export async function GET(req: NextRequest) {
  const g = await inventoryGuard(req, { edit: false, bucket: "levels" });
  if (!g.ok) return g.res;
  try {
    const sp = req.nextUrl.searchParams;
    const levels = await listLevels(g.scope.dataId, { productId: sp.get("product"), locationId: sp.get("location") });
    return NextResponse.json({ levels });
  } catch (err) {
    return inventoryErrorResponse(err, "stock.levels.GET");
  }
}
