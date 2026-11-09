import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { parseBody } from "@/lib/money/http";
import { listCounts, openCount } from "@/lib/inventory/counts";
import { inventoryErrorResponse, inventoryGuard } from "@/lib/inventory/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const OpenBody = z.object({ location_id: z.string().min(1).max(100) }).strict();

export async function GET(req: NextRequest) {
  const g = await inventoryGuard(req, { edit: false, bucket: "cnt.list" });
  if (!g.ok) return g.res;
  try {
    return NextResponse.json({ counts: await listCounts(g.scope.dataId) });
  } catch (err) {
    return inventoryErrorResponse(err, "stock-counts.GET");
  }
}

/** POST {location_id} — opens a count and snapshots the expected quantities. */
export async function POST(req: NextRequest) {
  const g = await inventoryGuard(req, { edit: true, bucket: "cnt.write" });
  if (!g.ok) return g.res;
  try {
    const body = await parseBody(req, OpenBody, 4_000);
    if (!body.ok) return body.res;
    const count = await openCount(g.scope.dataId, body.data.location_id, g.scope.userId);
    return NextResponse.json({ count }, { status: 201 });
  } catch (err) {
    return inventoryErrorResponse(err, "stock-counts.POST");
  }
}
