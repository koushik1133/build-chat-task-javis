import { query } from "@/lib/dsql";
import { AccountingNotConfiguredError, type AccountingProvider, type DateRange, type ExportFile } from "./types";

/**
 * RFC 4180 CSV. Fields are quoted only when they contain a comma, a double
 * quote, CR or LF (quotes are doubled); records end with CRLF; the header is
 * the first record. Money is exported in major units with two decimals so
 * spreadsheets and accounting imports read it as a number.
 *
 * Formula injection: a cell starting with `=`, `+`, `-`, `@`, TAB or CR is
 * evaluated by Excel / Sheets / LibreOffice when the file is opened. Customer
 * names, vendors, notes and descriptions are user-supplied, so such cells are
 * prefixed with a single quote (read as text). Plain numbers, including
 * negatives like `-2.50`, are left untouched so accounting imports still
 * parse them as numbers.
 */

export type CsvCell = string | number | boolean | null | undefined;

const PLAIN_NUMBER = /^-?\d+(?:\.\d+)?$/;
const FORMULA_START = /^[=+\-@\t\r]/;

/** True when a cell would be interpreted as a formula by a spreadsheet. */
export function isFormulaLike(s: string): boolean {
  return FORMULA_START.test(s) && !PLAIN_NUMBER.test(s);
}

export function csvField(v: CsvCell): string {
  if (v === null || v === undefined) return "";
  let s = typeof v === "string" ? v : String(v);
  if (isFormulaLike(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(headers: readonly string[], rows: ReadonlyArray<ReadonlyArray<CsvCell>>): string {
  const lines = [headers.map(csvField).join(",")];
  for (const r of rows) lines.push(r.map(csvField).join(","));
  return lines.join("\r\n") + "\r\n";
}

/** Minimal RFC 4180 reader (handles quoted fields, doubled quotes, CRLF/LF). Used by tests and imports. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"') inQuotes = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\r") {
      // swallow; LF terminates
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export function minorToMajor(minor: number | string | null | undefined): string {
  const n = Number(minor ?? 0);
  return (n / 100).toFixed(2);
}

function dateOnly(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
}

function rangeClause(col: string, params: unknown[], range: DateRange): string {
  let sql = "";
  if (range.from) {
    params.push(range.from);
    sql += ` AND ${col} >= $${params.length}`;
  }
  if (range.to) {
    params.push(range.to);
    sql += ` AND ${col} <= $${params.length}`;
  }
  return sql;
}

function stamp(range: DateRange): string {
  const f = range.from ? dateOnly(range.from) : "all";
  const t = range.to ? dateOnly(range.to) : "now";
  return `${f}_${t}`;
}

export const INVOICE_HEADERS = ["InvoiceNumber", "InvoiceDate", "DueDate", "Status", "Customer", "CustomerEmail", "Currency", "Subtotal", "Tax", "Total", "Paid", "Balance", "QuoteNumber", "Notes"] as const;
export const EXPENSE_HEADERS = ["Date", "Category", "Vendor", "Description", "Currency", "Amount", "Tax", "Total", "Billable", "JobKind", "JobId", "InvoiceNumber", "ReceiptUrl"] as const;
export const PAYMENT_HEADERS = ["Date", "InvoiceNumber", "Customer", "Provider", "Reference", "Currency", "Amount", "Status"] as const;

export const csvProvider: AccountingProvider = {
  name: "csv",
  configured: () => true,

  async exportInvoices(dataId, range) {
    const params: unknown[] = [dataId];
    const sql = `SELECT i.number, i.created_at, i.due_at, i.status, i.currency, i.subtotal_minor, i.tax_minor, i.total_minor, i.paid_minor, i.notes,
                        c.full_name AS customer, c.email AS customer_email, q.number AS quote_number
                   FROM invoices i LEFT JOIN crm_contacts c ON c.id = i.contact_id LEFT JOIN quotes q ON q.id = i.quote_id
                  WHERE i.user_id = $1 AND i.status <> 'draft'${rangeClause("i.created_at", params, range)}
                  ORDER BY i.created_at ASC`;
    const rows = await query<Record<string, string | number | null>>(sql, params);
    const body = toCsv(INVOICE_HEADERS, rows.map((r) => [
      r.number, dateOnly(r.created_at as string), dateOnly(r.due_at as string), r.status, r.customer, r.customer_email, r.currency,
      minorToMajor(r.subtotal_minor), minorToMajor(r.tax_minor), minorToMajor(r.total_minor), minorToMajor(r.paid_minor),
      minorToMajor(Number(r.total_minor) - Number(r.paid_minor)), r.quote_number, r.notes,
    ]));
    return { filename: `invoices_${stamp(range)}.csv`, contentType: "text/csv; charset=utf-8", body, rows: rows.length };
  },

  async exportExpenses(dataId, range) {
    const params: unknown[] = [dataId];
    const sql = `SELECT e.spent_at, e.category, e.vendor, e.description, e.currency, e.amount_minor, e.tax_minor, e.billable, e.ref_kind, e.ref_id, e.receipt_url,
                        i.number AS invoice_number
                   FROM expenses e LEFT JOIN invoices i ON i.id = e.invoice_id
                  WHERE e.user_id = $1${rangeClause("e.spent_at", params, range)}
                  ORDER BY e.spent_at ASC`;
    const rows = await query<Record<string, string | number | boolean | null>>(sql, params);
    const body = toCsv(EXPENSE_HEADERS, rows.map((r) => [
      dateOnly(r.spent_at as string), r.category as string, r.vendor as string, r.description as string, r.currency as string,
      minorToMajor(r.amount_minor as number), minorToMajor(r.tax_minor as number), minorToMajor(Number(r.amount_minor) + Number(r.tax_minor)),
      r.billable ? "yes" : "no", r.ref_kind as string, r.ref_id as string, r.invoice_number as string, r.receipt_url as string,
    ]));
    return { filename: `expenses_${stamp(range)}.csv`, contentType: "text/csv; charset=utf-8", body, rows: rows.length };
  },

  async exportPayments(dataId, range) {
    const params: unknown[] = [dataId];
    const sql = `SELECT p.created_at, p.provider, p.provider_ref, p.currency, p.amount_minor, p.status, i.number AS invoice_number, c.full_name AS customer
                   FROM invoice_payments p JOIN invoices i ON i.id = p.invoice_id LEFT JOIN crm_contacts c ON c.id = i.contact_id
                  WHERE i.user_id = $1 AND p.status = 'succeeded'${rangeClause("p.created_at", params, range)}
                  ORDER BY p.created_at ASC`;
    const rows = await query<Record<string, string | number | null>>(sql, params);
    const body = toCsv(PAYMENT_HEADERS, rows.map((r) => [
      dateOnly(r.created_at as string), r.invoice_number, r.customer, r.provider, r.provider_ref, r.currency, minorToMajor(r.amount_minor), r.status,
    ]));
    return { filename: `payments_${stamp(range)}.csv`, contentType: "text/csv; charset=utf-8", body, rows: rows.length };
  },
};

export function stubProvider(name: string): AccountingProvider {
  const notConfigured = async (): Promise<ExportFile> => {
    throw new AccountingNotConfiguredError(name);
  };
  return { name, configured: () => false, exportInvoices: notConfigured, exportExpenses: notConfigured, exportPayments: notConfigured };
}
