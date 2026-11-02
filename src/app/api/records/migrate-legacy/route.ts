import { NextResponse, type NextRequest } from "next/server";
import { requireScope } from "@/lib/auth/scope";
import { migrateLegacy } from "@/lib/records/packs";
import { MigrateLegacySchema, parseBody, recordsErrorResponse } from "@/lib/records/http";

export const runtime = "nodejs";
export const maxDuration = 60;

/** Copy legacy vertical-hub rows into records. Idempotent; safe to re-run. */
export async function POST(req: NextRequest) {
  try {
    const scope = await requireScope({ area: "crm", edit: true });
    const body = await parseBody(req, MigrateLegacySchema);
    if (!body.ok) return body.res;
    const results = await migrateLegacy(scope.dataId, body.data.tables);
    const created = results.reduce((n, r) => n + r.created, 0);
    const skipped = results.reduce((n, r) => n + r.skipped, 0);
    return NextResponse.json({ created, skipped, results });
  } catch (err) {
    return recordsErrorResponse(err, "records.migrate-legacy.POST");
  }
}
