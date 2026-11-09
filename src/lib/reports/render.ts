import { getBranding } from "@/lib/branding";
import { businessName } from "@/lib/money/quotes";
import { renderTablePdf } from "@/lib/pdf/report-document";
import { documentHash } from "@/lib/pdf/quote-document";
import type { ReportResult } from "./query";
import type { SavedReport } from "./store";
import { formattedRows, formattedTotals, reportCsv, safeFileName } from "./export";

/** Server-side: a report result → CSV or PDF HTTP response (shared by the authed export and the public token download). */
export async function buildReportExport(dataId: string, report: Pick<SavedReport, "name" | "description">, result: ReportResult, format: "csv" | "pdf"): Promise<Response> {
  if (format === "csv") {
    const body = reportCsv(result);
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${safeFileName(report.name, "csv")}"`,
        "Cache-Control": "private, no-store",
        "X-Export-Rows": String(result.rows.length),
      },
    });
  }
  const [branding, business] = await Promise.all([getBranding(dataId).catch(() => null), businessName(dataId).catch(() => "")]);
  const bytes = renderTablePdf(
    {
      title: report.name,
      subtitle: report.description ?? `${result.dataset} · ${result.rows.length} rows · ${result.timezone}`,
      columns: result.columns.map((c) => ({ key: c.key, label: c.label, align: c.kind === "measure" ? "right" : "left" })),
      rows: formattedRows(result),
      totals: formattedTotals(result),
      generated_at: result.generated_at,
    },
    { brand_name: branding?.brand_name ?? business, primary_color: branding?.primary_color ?? null },
    { business }
  );
  return new Response(Buffer.from(bytes), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Length": String(bytes.byteLength),
      "Content-Disposition": `attachment; filename="${safeFileName(report.name, "pdf")}"`,
      "Cache-Control": "private, no-store",
      "X-Document-SHA256": documentHash(bytes),
      "X-Export-Rows": String(result.rows.length),
    },
  });
}
