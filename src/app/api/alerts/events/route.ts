import { NextResponse } from "next/server";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { listEvents } from "@/lib/alerts/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/alerts/events?limit= — recent alert events for this org. */
export async function GET(req: Request) {
  let scope;
  try { scope = await requireScope({ area: "settings", edit: false }); } catch (err) { return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 }); }
  const limit = Number(new URL(req.url).searchParams.get("limit") ?? 50);
  try {
    return NextResponse.json({ events: await listEvents(scope.dataId, Number.isFinite(limit) ? limit : 50) });
  } catch (err) {
    console.error("[api/alerts/events] GET failed:", err);
    return NextResponse.json({ error: "Could not load alert events." }, { status: 500 });
  }
}
