import { NextResponse, type NextRequest } from "next/server";
import { paramId } from "@/lib/money/http";
import { recordAudit } from "@/lib/audit";
import { cancelTransfer } from "@/lib/inventory/transfers";
import { inventoryErrorResponse, inventoryGuard } from "@/lib/inventory/http";

export const runtime = "nodejs";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const g = await inventoryGuard(req, { edit: true, bucket: "tr.write" });
  if (!g.ok) return g.res;
  try {
    const id = await paramId(ctx);
    const transfer = await cancelTransfer(g.scope.dataId, id, g.scope.userId);
    void recordAudit({ dataId: g.scope.dataId, userId: g.scope.userId }, { action: "transfer.cancelled", entity: "stock_transfer", entityId: id });
    return NextResponse.json({ transfer });
  } catch (err) {
    return inventoryErrorResponse(err, "transfers.cancel.POST");
  }
}
