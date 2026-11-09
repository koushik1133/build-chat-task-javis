import { NextResponse, type NextRequest } from "next/server";
import { paramId } from "@/lib/money/http";
import { getCount } from "@/lib/inventory/counts";
import { inventoryErrorResponse, inventoryGuard } from "@/lib/inventory/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const g = await inventoryGuard(req, { edit: false, bucket: "cnt.get" });
  if (!g.ok) return g.res;
  try {
    const count = await getCount(g.scope.dataId, await paramId(ctx));
    if (!count) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ count });
  } catch (err) {
    return inventoryErrorResponse(err, "stock-counts.id.GET");
  }
}
