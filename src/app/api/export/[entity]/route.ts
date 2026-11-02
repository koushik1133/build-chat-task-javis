import { NextResponse, type NextRequest } from "next/server";
import { requireScope, scopeErrorResponse } from "@/lib/auth/scope";
import { recordAudit } from "@/lib/audit";
import { EXPORT_ENTITIES, ExportUnavailableError, exportFileName, fetchExportRows, isExportEntityKey, renderExport } from "@/lib/export";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/export/[entity]?format=csv|json&from=&to=(&type= for records)
 * Streams a file download of the caller's workspace data. Each entity has
 * its own permission area. "accounting" is owned by a dedicated route.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ entity: string }> }) {
  const { entity: key } = await ctx.params;
  if (!isExportEntityKey(key)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const entity = EXPORT_ENTITIES[key];

  let scope;
  try {
    scope = await requireScope({ area: entity.area, edit: false });
  } catch (err) {
    return scopeErrorResponse(err) ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const sp = req.nextUrl.searchParams;
  const formatRaw = (sp.get("format") ?? "csv").toLowerCase();
  if (formatRaw !== "csv" && formatRaw !== "json") return NextResponse.json({ error: "invalid_format" }, { status: 400 });
  const format = formatRaw as "csv" | "json";
  const opts = { from: sp.get("from"), to: sp.get("to"), type: sp.get("type")?.slice(0, 80) ?? null };

  let rows;
  try {
    rows = await fetchExportRows(scope.dataId, entity, opts);
  } catch (err) {
    if (err instanceof ExportUnavailableError) return NextResponse.json({ error: "not_found", detail: err.message }, { status: 404 });
    console.error(`[export:${key}]`, err);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }

  void recordAudit(scope, { action: "export", entity: key, entityId: null, after: { format, count: rows.length, from: opts.from, to: opts.to }, req }).catch(() => undefined);

  const { body, contentType } = renderExport(rows, entity, format);
  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Content-Disposition": `attachment; filename="${exportFileName(entity, format, opts)}"`,
      "Cache-Control": "no-store",
      "X-Row-Count": String(rows.length),
    },
  });
}
