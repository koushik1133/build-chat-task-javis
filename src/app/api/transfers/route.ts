import { NextResponse, type NextRequest } from "next/server";
import { parseBody } from "@/lib/money/http";
import { recordAudit } from "@/lib/audit";
import { createTransfer, listTransfers, TransferCreateSchema } from "@/lib/inventory/transfers";
import { inventoryErrorResponse, inventoryGuard } from "@/lib/inventory/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/transfers?status=&location= */
export async function GET(req: NextRequest) {
  const g = await inventoryGuard(req, { edit: false, bucket: "tr.list" });
  if (!g.ok) return g.res;
  try {
    const sp = req.nextUrl.searchParams;
    return NextResponse.json({ transfers: await listTransfers(g.scope.dataId, { status: sp.get("status"), locationId: sp.get("location") }) });
  } catch (err) {
    return inventoryErrorResponse(err, "transfers.GET");
  }
}

export async function POST(req: NextRequest) {
  const g = await inventoryGuard(req, { edit: true, bucket: "tr.write" });
  if (!g.ok) return g.res;
  try {
    const body = await parseBody(req, TransferCreateSchema, 64_000);
    if (!body.ok) return body.res;
    const transfer = await createTransfer(g.scope.dataId, body.data, g.scope.userId);
    void recordAudit({ dataId: g.scope.dataId, userId: g.scope.userId }, { action: "transfer.created", entity: "stock_transfer", entityId: transfer.id, after: { number: transfer.number } });
    return NextResponse.json({ transfer }, { status: 201 });
  } catch (err) {
    return inventoryErrorResponse(err, "transfers.POST");
  }
}
