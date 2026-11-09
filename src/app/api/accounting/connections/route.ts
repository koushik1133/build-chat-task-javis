import { NextRequest, NextResponse } from "next/server";
import { deleteConnection, describeLiveProviders, listConnections } from "@/lib/accounting/connections";
import { recordAudit } from "@/lib/audit";
import { tableExists } from "@/lib/table-exists";
import { billingScope, isResponse, settingsScope } from "../_shared";

export const dynamic = "force-dynamic";

/** Connected accounting systems (never includes credentials) + provider availability. */
export async function GET() {
  const scope = await billingScope(false);
  if (isResponse(scope)) return scope;
  try {
    const ready = await tableExists("accounting_connections");
    const connections = ready ? await listConnections(scope.dataId) : [];
    return NextResponse.json({ connections, providers: describeLiveProviders(), migrated: ready });
  } catch (err) {
    console.error("[accounting/connections] list failed:", err);
    return NextResponse.json({ error: "Could not load accounting connections." }, { status: 500 });
  }
}

/** Disconnect: removes links, log and credentials. Remote records are left untouched. */
export async function DELETE(req: NextRequest) {
  const scope = await settingsScope();
  if (isResponse(scope)) return scope;
  const id = req.nextUrl.searchParams.get("id")?.trim() ?? "";
  if (!id || id.length > 100) return NextResponse.json({ error: "id is required" }, { status: 400 });
  try {
    const ok = await deleteConnection(scope.dataId, id);
    if (!ok) return NextResponse.json({ error: "Connection not found" }, { status: 404 });
    await recordAudit(scope, { action: "accounting.disconnect", entity: "accounting_connection", entityId: id });
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[accounting/connections] delete failed:", err);
    return NextResponse.json({ error: "Could not disconnect that integration." }, { status: 500 });
  }
}
