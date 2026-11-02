import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { parseBody } from "@/lib/money/http";
import { parseCsv } from "@/lib/import/parse";
import { suggestMapping } from "@/lib/import/mapping";
import { describeTargets, getImportTarget, IMPORT_TARGET_KEYS } from "@/lib/import/targets";
import { MAX_IMPORT_ROWS } from "@/lib/import/run";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const CSV_MAX_BYTES = 5 * 1024 * 1024;

const Body = z
  .object({
    csv: z.string().min(1),
    target: z.enum(IMPORT_TARGET_KEYS),
    /** Skip AI refinement (faster). */
    ai: z.boolean().optional(),
  })
  .strict();

/** GET /api/import/preview — describe the available targets and their fields. */
export async function GET() {
  try {
    await requireScope({ area: "settings", edit: false });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return NextResponse.json({ targets: describeTargets(), maxRows: MAX_IMPORT_ROWS, maxBytes: CSV_MAX_BYTES });
}

/** POST /api/import/preview {csv, target} → headers, sample rows, suggested mapping. */
export async function POST(req: NextRequest) {
  const parsed = await parseBody(req, Body, CSV_MAX_BYTES + 1024);
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
  if (csv.rows.length > MAX_IMPORT_ROWS) {
    return NextResponse.json({ error: "too_many_rows", detail: `Maximum ${MAX_IMPORT_ROWS} rows per import.` }, { status: 400 });
  }

  const sample = csv.rows.slice(0, 25);
  const suggestion = await suggestMapping(csv.headers, sample, target, { useAi: parsed.data.ai !== false });

  return NextResponse.json({
    target: { key: target.key, label: target.label, fields: target.fields, dedupeKey: target.dedupeKey },
    headers: csv.headers,
    delimiter: csv.delimiter,
    rowCount: csv.rows.length,
    sample: sample.slice(0, 5),
    suggestion,
    workspace: scope.orgName,
  });
}
