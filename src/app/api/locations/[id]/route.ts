import { NextResponse, type NextRequest } from "next/server";
import { paramId, parseBody } from "@/lib/money/http";
import { recordAudit } from "@/lib/audit";
import { getLocation, LocationPatchSchema, updateLocation } from "@/lib/inventory/locations";
import { inventoryErrorResponse, inventoryGuard } from "@/lib/inventory/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  const g = await inventoryGuard(req, { edit: false, bucket: "loc.get" });
  if (!g.ok) return g.res;
  try {
    const location = await getLocation(g.scope.dataId, await paramId(ctx));
    if (!location) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ location });
  } catch (err) {
    return inventoryErrorResponse(err, "locations.id.GET");
  }
}

/** PATCH — edit, set default, or archive (`active:false`; refused while stock remains). */
export async function PATCH(req: NextRequest, ctx: Ctx) {
  const g = await inventoryGuard(req, { edit: true, bucket: "loc.write" });
  if (!g.ok) return g.res;
  try {
    const body = await parseBody(req, LocationPatchSchema, 16_000);
    if (!body.ok) return body.res;
    const id = await paramId(ctx);
    const location = await updateLocation(g.scope.dataId, id, body.data);
    void recordAudit({ dataId: g.scope.dataId, userId: g.scope.userId }, { action: "location.updated", entity: "location", entityId: id, after: { keys: Object.keys(body.data) } });
    return NextResponse.json({ location });
  } catch (err) {
    return inventoryErrorResponse(err, "locations.id.PATCH");
  }
}
