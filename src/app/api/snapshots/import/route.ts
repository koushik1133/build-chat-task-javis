import { NextResponse, type NextRequest } from "next/server";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { dbUnavailableResponse } from "@/lib/api-db";
import { rateLimitAsync, readCappedText } from "@/lib/request-limits";
import { importSnapshot, SnapshotError } from "@/lib/snapshots/store";
import { MAX_SNAPSHOT_BYTES } from "@/lib/snapshots/types";

export const dynamic = "force-dynamic";

/**
 * POST /api/snapshots/import — body is the snapshot JSON itself (≤ 5 MB).
 * Validated against the schema and scanned for credential-like keys/values
 * before it is stored; a foreign file with a secret is rejected with 422.
 */
export async function POST(req: NextRequest) {
  let scope;
  try {
    scope = await requireScope({ area: "settings", edit: true });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const rl = await rateLimitAsync(`snapshots:import:${scope.dataId}`, 20, 60 * 60 * 1000);
  if (!rl.allowed) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  const text = await readCappedText(req, MAX_SNAPSHOT_BYTES + 1024);
  if (text === null) return NextResponse.json({ error: "payload_too_large" }, { status: 413 });
  try {
    const snapshot = await importSnapshot(scope.dataId, text, { actorId: scope.userId, orgId: scope.orgId });
    return NextResponse.json({ snapshot }, { status: 201 });
  } catch (err) {
    if (err instanceof SnapshotError) return NextResponse.json({ error: err.message }, { status: err.status });
    return dbUnavailableResponse(err, "snapshots/import");
  }
}
