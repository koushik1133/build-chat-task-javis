import { NextResponse, type NextRequest } from "next/server";
import { paramId } from "@/lib/money/http";
import { getTransfer } from "@/lib/inventory/transfers";
import { inventoryErrorResponse, inventoryGuard } from "@/lib/inventory/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const g = await inventoryGuard(req, { edit: false, bucket: "tr.get" });
  if (!g.ok) return g.res;
  try {
    const transfer = await getTransfer(g.scope.dataId, await paramId(ctx));
    if (!transfer) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ transfer });
  } catch (err) {
    return inventoryErrorResponse(err, "transfers.id.GET");
  }
}
