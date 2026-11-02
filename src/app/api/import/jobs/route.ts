import { NextResponse, type NextRequest } from "next/server";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { listImportJobs } from "@/lib/import/run";

export const dynamic = "force-dynamic";

/** GET /api/import/jobs?limit= — recent imports (dry runs included) for the workspace. */
export async function GET(req: NextRequest) {
  let scope;
  try {
    scope = await requireScope({ area: "settings", edit: false });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const limit = Number(req.nextUrl.searchParams.get("limit") ?? "50");
  const jobs = await listImportJobs(scope.dataId, Number.isFinite(limit) ? limit : 50).catch((err) => {
    console.error("[import:jobs]", err);
    return [];
  });
  return NextResponse.json({ jobs });
}
