import { NextResponse, type NextRequest } from "next/server";
import { paramId } from "@/lib/money/http";
import { recordAudit } from "@/lib/audit";
import { applyCount } from "@/lib/inventory/counts";
import { inventoryErrorResponse, inventoryGuard } from "@/lib/inventory/http";

export const runtime = "nodejs";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const g = await inventoryGuard(req, { edit: true, bucket: "cnt.write" });
  if (!g.ok) return g.res;
  try {
    const id = await paramId(ctx);
    const count = await applyCount(g.scope.dataId, id, g.scope.userId);
    void recordAudit({ dataId: g.scope.dataId, userId: g.scope.userId }, { action: "stock_count.applied", entity: "stock_count", entityId: id, after: { net_variance: count.summary.net_variance } });
    return NextResponse.json({ count });
  } catch (err) {
    return inventoryErrorResponse(err, "stock-counts.apply.POST");
  }
}
