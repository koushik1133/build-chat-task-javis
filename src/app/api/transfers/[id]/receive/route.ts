import { NextResponse, type NextRequest } from "next/server";
import { paramId, parseBody } from "@/lib/money/http";
import { recordAudit } from "@/lib/audit";
import { receiveTransfer, TransferReceiveSchema } from "@/lib/inventory/transfers";
import { inventoryErrorResponse, inventoryGuard } from "@/lib/inventory/http";

export const runtime = "nodejs";

/** POST {lines?:[{product_id, received_qty}], close_short?} — omit lines to receive everything outstanding. */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const g = await inventoryGuard(req, { edit: true, bucket: "tr.write" });
  if (!g.ok) return g.res;
  try {
    const body = await parseBody(req, TransferReceiveSchema, 64_000);
    if (!body.ok) return body.res;
    const id = await paramId(ctx);
    const transfer = await receiveTransfer(g.scope.dataId, id, body.data, g.scope.userId);
    void recordAudit({ dataId: g.scope.dataId, userId: g.scope.userId }, { action: "transfer.received", entity: "stock_transfer", entityId: id, after: { status: transfer.status } });
    return NextResponse.json({ transfer });
  } catch (err) {
    return inventoryErrorResponse(err, "transfers.receive.POST");
  }
}
