import { NextRequest, NextResponse } from "next/server";
import { recordAudit } from "@/lib/audit";
import { deleteConnection, describeCalendarProviders, listConnections } from "@/lib/calsync/connections";
import { tableExists } from "@/lib/table-exists";
import { isResponse, syncScope } from "../_shared";

export const dynamic = "force-dynamic";

/** Connected external calendars (never includes credentials) + provider availability. */
export async function GET() {
  const scope = await syncScope(false);
  if (isResponse(scope)) return scope;
  try {
    const ready = await tableExists("calendar_connections");
    const connections = ready ? await listConnections(scope.dataId) : [];
    return NextResponse.json({ connections, providers: describeCalendarProviders(), migrated: ready, canEdit: scope.can("settings", true) });
  } catch (err) {
    console.error("[calsync/connections] list failed:", err);
    return NextResponse.json({ error: "Could not load calendar connections." }, { status: 500 });
  }
}

/** Disconnect: removes links, busy blocks and credentials. Events already pushed stay in the external calendar. */
export async function DELETE(req: NextRequest) {
  const scope = await syncScope(true);
  if (isResponse(scope)) return scope;
  const id = req.nextUrl.searchParams.get("id")?.trim() ?? "";
  if (!id || id.length > 100) return NextResponse.json({ error: "id is required" }, { status: 400 });
  try {
    const ok = await deleteConnection(scope.dataId, id);
    if (!ok) return NextResponse.json({ error: "Connection not found" }, { status: 404 });
    await recordAudit(scope, { action: "calsync.disconnect", entity: "calendar_connection", entityId: id });
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[calsync/connections] delete failed:", err);
    return NextResponse.json({ error: "Could not disconnect that calendar." }, { status: 500 });
  }
}
