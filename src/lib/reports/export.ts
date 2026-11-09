import { toCsv } from "@/lib/export/csv";
import { formatValue, type ReportRow } from "./chart";
import type { OutputColumn } from "./compile";
import type { ReportResult } from "./query";

/** Render a report result as CSV / formatted table cells / an HTML table (email). Pure. */

export function reportCsv(result: Pick<ReportResult, "columns" | "rows" | "totals">): string {
  const rows: Array<Record<string, unknown>> = result.rows.map((r) => ({ ...r }));
  if (result.totals) rows.push({ ...result.totals, [result.columns[0]?.key ?? "total"]: result.columns[0]?.kind === "measure" ? result.totals[result.columns[0].key] : "Total" });
  return toCsv(rows, result.columns.map((c) => ({ key: c.key, label: c.label })), { bom: true });
}

export function formatCell(v: ReportRow[string], col: OutputColumn, currency: string): string {
  if (col.kind === "measure") return formatValue(v, col.format, currency);
  if (col.kind === "date" && typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v)) return v.slice(0, 16).replace("T", " ");
  return v === null || v === undefined || v === "" ? "—" : String(v);
}

export function formattedRows(result: Pick<ReportResult, "columns" | "rows" | "currency">): Array<Record<string, string>> {
  return result.rows.map((r) => Object.fromEntries(result.columns.map((c) => [c.key, formatCell(r[c.key], c, result.currency)])));
}

export function formattedTotals(result: Pick<ReportResult, "columns" | "totals" | "currency">): Record<string, string> | null {
  if (!result.totals) return null;
  return Object.fromEntries(result.columns.filter((c) => c.kind === "measure").map((c) => [c.key, formatCell(result.totals?.[c.key] ?? null, c, result.currency)]));
}

export function safeFileName(name: string, ext: string): string {
  const base = name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "report";
  return `${base}-${new Date().toISOString().slice(0, 10)}.${ext}`;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}

/** Compact inline table for emails (first `max` rows). */
export function reportHtmlTable(result: Pick<ReportResult, "columns" | "rows" | "totals" | "currency">, max = 25): string {
  const cols = result.columns.slice(0, 8);
  const rows = formattedRows({ ...result, rows: result.rows.slice(0, max) });
  const totals = formattedTotals(result);
  const th = cols.map((c) => `<th style="text-align:${c.kind === "measure" ? "right" : "left"};padding:6px 8px;border-bottom:1px solid #ddd;font-size:12px;color:#666">${escapeHtml(c.label)}</th>`).join("");
  const tr = rows.map((r) => `<tr>${cols.map((c) => `<td style="text-align:${c.kind === "measure" ? "right" : "left"};padding:6px 8px;border-bottom:1px solid #eee;font-size:13px">${escapeHtml(r[c.key] ?? "")}</td>`).join("")}</tr>`).join("");
  const tf = totals ? `<tr>${cols.map((c, i) => `<td style="text-align:${c.kind === "measure" ? "right" : "left"};padding:6px 8px;font-weight:600;font-size:13px">${escapeHtml(i === 0 && c.kind !== "measure" ? "Total" : (totals[c.key] ?? ""))}</td>`).join("")}</tr>` : "";
  const more = result.rows.length > max ? `<p style="font-size:12px;color:#666">Showing ${max} of ${result.rows.length} rows.</p>` : "";
  return `<table role="presentation" style="border-collapse:collapse;width:100%"><thead><tr>${th}</tr></thead><tbody>${tr || `<tr><td colspan="${cols.length}" style="padding:8px;color:#666">No rows for this period.</td></tr>`}${tf}</tbody></table>${more}`;
}
