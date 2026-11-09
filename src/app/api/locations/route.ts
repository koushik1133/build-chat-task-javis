import { NextResponse, type NextRequest } from "next/server";
import { parseBody } from "@/lib/money/http";
import { planGate } from "@/lib/plans/http";
import { recordAudit } from "@/lib/audit";
import { createLocation, listLocations, LocationInputSchema } from "@/lib/inventory/locations";
import { inventoryErrorResponse, inventoryGuard } from "@/lib/inventory/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/locations?inactive=1 */
export async function GET(req: NextRequest) {
  const g = await inventoryGuard(req, { edit: false, bucket: "loc.list" });
  if (!g.ok) return g.res;
  try {
    return NextResponse.json({ locations: await listLocations(g.scope.dataId, { includeInactive: req.nextUrl.searchParams.get("inactive") === "1" }) });
  } catch (err) {
    return inventoryErrorResponse(err, "locations.GET");
  }
}

/** POST /api/locations — plan-limited (`locations`). */
export async function POST(req: NextRequest) {
  const g = await inventoryGuard(req, { edit: true, bucket: "loc.write" });
  if (!g.ok) return g.res;
  try {
    const body = await parseBody(req, LocationInputSchema, 16_000);
    if (!body.ok) return body.res;
    const gate = await planGate(g.scope, { metric: "locations" });
    if (gate) return gate;
    const location = await createLocation(g.scope.dataId, body.data);
    void recordAudit({ dataId: g.scope.dataId, userId: g.scope.userId }, { action: "location.created", entity: "location", entityId: location.id, after: { name: location.name } });
    return NextResponse.json({ location }, { status: 201 });
  } catch (err) {
    return inventoryErrorResponse(err, "locations.POST");
  }
}
