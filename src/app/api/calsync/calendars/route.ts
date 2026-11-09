import { NextRequest, NextResponse } from "next/server";
import { ensureFreshAuth, getCalendarProvider, getConnection } from "@/lib/calsync/connections";
import { isResponse, syncScope } from "../_shared";

export const dynamic = "force-dynamic";

/** GET ?connection_id=: the external calendars on that account, for the picker. */
export async function GET(req: NextRequest) {
  const scope = await syncScope(false);
  if (isResponse(scope)) return scope;
  const id = req.nextUrl.searchParams.get("connection_id")?.trim() ?? "";
  if (!id) return NextResponse.json({ error: "connection_id is required" }, { status: 400 });
  const row = await getConnection(scope.dataId, id);
  const provider = row ? getCalendarProvider(row.provider) : null;
  if (!row || !provider) return NextResponse.json({ error: "Connection not found" }, { status: 404 });
  try {
    const calendars = await provider.listCalendars(await ensureFreshAuth(row));
    return NextResponse.json({ calendars });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message.slice(0, 300) : "Could not list calendars" }, { status: 502 });
  }
}
