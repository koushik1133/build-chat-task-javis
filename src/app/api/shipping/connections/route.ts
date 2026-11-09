import { NextResponse, type NextRequest } from "next/server";
import { requireScope } from "@/lib/auth/scope";
import { parseBody } from "@/lib/money/http";
import { planGate } from "@/lib/plans/http";
import { shippingError } from "@/lib/shipping/http";
 import { ConnectionInputSchema, listConnectionViews, removeConnection, saveConnection } from "@/lib/shipping";
import { recordAudit } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const scope = await requireScope({ area: "billing", edit: false });
    return NextResponse.json({ connections: await listConnectionViews(scope.dataId) });
  } catch (err) {
    return shippingError(err, "shipping.connections.GET");
  }
}

/** PUT /api/shipping/connections — connect a carrier / save ship-from and default package. The key is encrypted and never returned. */
export async function PUT(req: NextRequest) {
  try {
    const scope = await requireScope({ area: "billing", edit: true });
    const body = await parseBody(req, ConnectionInputSchema);
    if (!body.ok) return body.res;
    if (body.data.api_key) {
      const gate = await planGate(scope, { feature: "shipping" });
      if (gate) return gate;
    }
    const connections = await saveConnection(scope.dataId, body.data);
    void recordAudit({ dataId: scope.dataId, userId: scope.userId }, { action: "shipping.connection_saved", entity: "shipping_connection", entityId: body.data.provider, after: { provider: body.data.provider, key_changed: Boolean(body.data.api_key) } });
    return NextResponse.json({ connections });
  } catch (err) {
    return shippingError(err, "shipping.connections.PUT");
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const scope = await requireScope({ area: "billing", edit: true });
    const provider = req.nextUrl.searchParams.get("provider") ?? "";
    if (provider === "simulated" || !["easypost", "shippo"].includes(provider)) return NextResponse.json({ error: "invalid_body" }, { status: 400 });
    await removeConnection(scope.dataId, provider);
    return NextResponse.json({ connections: await listConnectionViews(scope.dataId) });
  } catch (err) {
    return shippingError(err, "shipping.connections.DELETE");
  }
}
