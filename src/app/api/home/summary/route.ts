import { NextResponse } from "next/server";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { dbUnavailableResponse } from "@/lib/api-db";
import { buildHomeSummary } from "@/lib/home/summary";

export const dynamic = "force-dynamic";

/** GET /api/home/summary — everything the home dashboard needs in one round-trip (role-aware). */
export async function GET() {
  let scope;
  try {
    scope = await requireScope({});
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const summary = await buildHomeSummary({ dataId: scope.dataId, can: (area, edit) => scope.can(area, edit) });
    return NextResponse.json(summary, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    return dbUnavailableResponse(err, "home/summary");
  }
}
