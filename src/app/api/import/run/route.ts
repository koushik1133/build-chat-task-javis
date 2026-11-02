import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { recordAudit } from "@/lib/audit";
import { parseBody } from "@/lib/money/http";
import { parseCsv } from "@/lib/import/parse";
import { getImportTarget, IMPORT_TARGET_KEYS } from "@/lib/import/targets";
import { MAX_IMPORT_ROWS, runImport } from "@/lib/import/run";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

const CSV_MAX_BYTES = 5 * 1024 * 1024;

const Body = z
  .object({
    csv: z.string().min(1),
    target: z.enum(IMPORT_TARGET_KEYS),
    mapping: z.record(z.string(), z.string().max(200).nullable()),
    dryRun: z.boolean().optional(),
    fileName: z.string().max(200).optional(),
  })
  .strict();

/** POST /api/import/run {csv, target, mapping, dryRun} → {inserted, skipped, errors[]} */
export async function POST(req: NextRequest) {
  const parsed = await parseBody(req, Body, CSV_MAX_BYTES + 4096);
  if (!parsed.ok) return parsed.res;
  const target = getImportTarget(parsed.data.target);

  let scope;
  try {
    scope = await requireScope({ area: target.area, edit: true });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const csv = parseCsv(parsed.data.csv, { maxRows: MAX_IMPORT_ROWS + 1 });
  if (csv.headers.length === 0) return NextResponse.json({ error: "empty_csv", detail: "No header row found." }, { status: 400 });

  // Only keep mapping entries for real fields; unknown keys are ignored.
  const fieldKeys = new Set(target.fields.map((f) => f.key));
  const mapping: Record<string, string | null> = {};
  for (const [k, v] of Object.entries(parsed.data.mapping)) if (fieldKeys.has(k)) mapping[k] = v;

  const dryRun = parsed.data.dryRun ?? false;
  try {
    const result = await runImport(scope.dataId, target, csv.headers, csv.rows, mapping, {
      dryRun,
      actorId: scope.userId,
      fileName: parsed.data.fileName ?? null,
    });
    if (!dryRun && result.inserted > 0) {
      void recordAudit(scope, {
        action: "import",
        entity: target.table,
        entityId: result.jobId,
        after: { inserted: result.inserted, skipped: result.skipped, errors: result.errors.length },
        req,
      }).catch(() => undefined);
    }
    return NextResponse.json(result);
  } catch (err) {
    console.error("[import:run]", err);
    return NextResponse.json({ error: "internal_error", detail: "Import failed. Nothing may have been written; check the job list." }, { status: 500 });
  }
}
