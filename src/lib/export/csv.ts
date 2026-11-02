/**
 * CSV writer (RFC 4180, CRLF, UTF-8 BOM optional) with spreadsheet-formula
 * injection protection: cells starting with = + - @ or a tab/CR are prefixed
 * with a single quote so Excel/Sheets treat them as text.
 */

export interface CsvColumn {
  key: string;
  label?: string;
}

export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  let str: string;
  if (value instanceof Date) str = value.toISOString();
  else if (typeof value === "object") str = JSON.stringify(value);
  else str = String(value);
  if (/^[=+\-@\t\r]/.test(str)) str = `'${str}`;
  if (/[",\r\n]/.test(str)) str = `"${str.replace(/"/g, '""')}"`;
  return str;
}

export function toCsv(rows: Array<Record<string, unknown>>, columns: CsvColumn[], opts: { bom?: boolean } = {}): string {
  const header = columns.map((c) => csvCell(c.label ?? c.key)).join(",");
  const lines = rows.map((r) => columns.map((c) => csvCell(r[c.key])).join(","));
  return (opts.bom ? "﻿" : "") + [header, ...lines].join("\r\n") + "\r\n";
}
