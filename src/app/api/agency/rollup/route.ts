import { NextResponse, type NextRequest } from "next/server";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { dbUnavailableResponse } from "@/lib/api-db";
import { rollup } from "@/lib/agency/rollup";

export const dynamic = "force-dynamic";

function isoOrNull(v: string | null): string | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** GET /api/agency/rollup?from=&to= — per-client KPIs + totals for the active agency. */
export async function GET(req: NextRequest) {
  let scope;
  try {
    scope = await requireScope({ area: "reports" });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const sp = req.nextUrl.searchParams;
  const to = isoOrNull(sp.get("to")) ?? new Date().toISOString();
  const from = isoOrNull(sp.get("from")) ?? new Date(new Date(to).getTime() - 30 * 86_400_000).toISOString();
  if (new Date(from) > new Date(to)) return NextResponse.json({ error: "bad_request", detail: "from must be before to" }, { status: 400 });
  try {
    const report = await rollup(scope.dataId, { from, to });
    return NextResponse.json({ report });
  } catch (err) {
    return dbUnavailableResponse(err, "agency/rollup");
  }
}
