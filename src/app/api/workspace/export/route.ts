import { NextResponse, type NextRequest } from "next/server";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { recordAudit } from "@/lib/audit";
import { rateLimitAsync } from "@/lib/request-limits";
import { tenantExportStream, verifyResume } from "@/lib/snapshots/tenant-export";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * POST /api/workspace/export[?table=<name>&after=<id>] — full tenant export as
 * NDJSON (owner only, 3 per day). Resume a budget-truncated export with the
 * `resume` cursor from the final manifest line.
 */
export async function POST(req: NextRequest) {
  let scope;
  try {
    scope = await requireScope({ area: "settings", edit: true });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (scope.role !== "owner") return NextResponse.json({ error: "forbidden", detail: "Only the workspace owner can export everything." }, { status: 403 });
  const sp = req.nextUrl.searchParams;
  // Only a server-signed cursor (from a previous manifest) earns the roomy resume bucket; a hand-made
  // ?table=... is a fresh export and counts against the daily cap.
  const resuming = Boolean(sp.get("table")) && verifyResume(scope.dataId, sp.get("table") as string, sp.get("after"), sp.get("sig"));
  // A resume continues an export that already consumed a slot; give it a separate, roomier bucket.
  const rl = resuming
    ? await rateLimitAsync(`workspace:export:resume:${scope.dataId}`, 60, 24 * 60 * 60 * 1000)
    : await rateLimitAsync(`workspace:export:${scope.dataId}`, 3, 24 * 60 * 60 * 1000);
  if (!rl.allowed) return NextResponse.json({ error: "rate_limited", detail: "Full exports are limited to 3 per day." }, { status: 429 });

  await recordAudit(scope, { action: "workspace.export", entity: "workspace", entityId: scope.dataId, after: { resumed: resuming, table: sp.get("table") }, req });
  const stamp = new Date().toISOString().slice(0, 10);
  return new NextResponse(tenantExportStream(scope.dataId, { table: sp.get("table"), after: sp.get("after") }), {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "content-disposition": `attachment; filename="workspace-export-${stamp}.ndjson"`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
