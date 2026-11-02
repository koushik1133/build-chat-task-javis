/**
 * RFC 4180 CSV parser.
 *
 * Handles quoted fields (with "" escapes and embedded newlines), CRLF / LF /
 * CR line endings, a leading UTF-8 BOM, and auto-detects the delimiter
 * (comma, semicolon, tab, pipe) from the header line. Pure, dependency-free,
 * and safe to run on the client as well as the server.
 */

export interface ParsedCsv {
  headers: string[];
  rows: string[][];
  delimiter: string;
  /** Rows dropped because they were completely empty. */
  blankRows: number;
}

export interface ParseOptions {
  delimiter?: string;
  /** Treat the first line as headers (default true). */
  hasHeader?: boolean;
  /** Hard cap on data rows to protect memory. Default 50 000. */
  maxRows?: number;
}

const CANDIDATES = [",", ";", "\t", "|"];

export function detectDelimiter(text: string): string {
  const firstLine = text.split(/\r\n|\n|\r/, 1)[0] ?? "";
  let best = ",";
  let bestCount = -1;
  for (const d of CANDIDATES) {
    // Count occurrences outside quotes.
    let count = 0;
    let inQ = false;
    for (const ch of firstLine) {
      if (ch === '"') inQ = !inQ;
      else if (!inQ && ch === d) count++;
    }
    if (count > bestCount) {
      best = d;
      bestCount = count;
    }
  }
  return best;
}

/** Split CSV text into records of fields. Does not interpret a header. */
export function parseCsvRecords(input: string, delimiter?: string, maxRows = 50_000): { records: string[][]; delimiter: string } {
  let text = input ?? "";
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const d = delimiter ?? detectDelimiter(text);

  const records: string[][] = [];
  let fields: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const n = text.length;

  const endField = () => {
    fields.push(field);
    field = "";
  };
  const endRecord = () => {
    endField();
    records.push(fields);
    fields = [];
  };

  while (i < n) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      // RFC 4180 only allows quotes at field start; tolerate mid-field quotes literally.
      if (field.length === 0) inQuotes = true;
      else field += ch;
      i++;
      continue;
    }
    if (ch === d) {
      endField();
      i++;
      continue;
    }
    if (ch === "\r") {
      endRecord();
      i += text[i + 1] === "\n" ? 2 : 1;
      if (records.length > maxRows + 1) break;
      continue;
    }
    if (ch === "\n") {
      endRecord();
      i++;
      if (records.length > maxRows + 1) break;
      continue;
    }
    field += ch;
    i++;
  }
  // Flush the trailing record when the file does not end with a newline.
  if (field.length > 0 || fields.length > 0) endRecord();

  return { records, delimiter: d };
}

export function parseCsv(input: string, opts: ParseOptions = {}): ParsedCsv {
  const { records, delimiter } = parseCsvRecords(input, opts.delimiter, opts.maxRows ?? 50_000);
  const hasHeader = opts.hasHeader ?? true;
  const isBlank = (r: string[]) => r.every((c) => c.trim() === "");

  let headers: string[] = [];
  let body = records;
  if (hasHeader) {
    const idx = records.findIndex((r) => !isBlank(r));
    if (idx === -1) return { headers: [], rows: [], delimiter, blankRows: records.length };
    headers = records[idx].map((h, k) => {
      const t = h.trim();
      return t === "" ? `column_${k + 1}` : t;
    });
    body = records.slice(idx + 1);
  }

  let blankRows = 0;
  const width = hasHeader ? headers.length : Math.max(0, ...records.map((r) => r.length));
  const rows: string[][] = [];
  for (const r of body) {
    if (isBlank(r)) {
      blankRows++;
      continue;
    }
    // Normalise width so downstream can index by header position.
    const row = r.slice(0, Math.max(width, r.length));
    while (row.length < width) row.push("");
    rows.push(row);
    if (rows.length >= (opts.maxRows ?? 50_000)) break;
  }
  return { headers, rows, delimiter, blankRows };
}

/** Rows as objects keyed by header (duplicate headers get a numeric suffix). */
export function rowsToObjects(parsed: ParsedCsv): Array<Record<string, string>> {
  const keys = uniqueHeaders(parsed.headers);
  return parsed.rows.map((r) => {
    const o: Record<string, string> = {};
    keys.forEach((k, i) => {
      o[k] = r[i] ?? "";
    });
    return o;
  });
}

export function uniqueHeaders(headers: string[]): string[] {
  const seen = new Map<string, number>();
  return headers.map((h) => {
    const c = seen.get(h) ?? 0;
    seen.set(h, c + 1);
    return c === 0 ? h : `${h}_${c + 1}`;
  });
}
