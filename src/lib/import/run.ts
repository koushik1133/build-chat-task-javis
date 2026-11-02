import { randomUUID } from "crypto";
import { query } from "@/lib/dsql";
import { tableExists } from "@/lib/table-exists";
import type { Mapping } from "./mapping";
import type { ImportField, ImportTarget, NormalisedRow } from "./targets";

/**
 * Coerce, validate, de-duplicate and insert CSV rows for a target.
 * Money → integer minor units; dates → ISO; booleans → booleans.
 */

export interface ImportError {
  row: number; // 1-based data row (header excluded)
  field?: string;
  message: string;
}

export interface ImportResult {
  inserted: number;
  skipped: number;
  errors: ImportError[];
  rowCount: number;
  dryRun: boolean;
  jobId: string | null;
}

export const MAX_IMPORT_ROWS = 20_000;
const MAX_ERRORS = 200;

// ── Coercion ─────────────────────────────────────────────────────────────────

/** "$1,234.56" → 123456; "1.234,56" → 123456; "(12.00)" → -1200; "12" → 1200. */
export function toMoneyMinor(raw: string): number | null {
  let v = raw.trim();
  if (!v) return null;
  let negative = false;
  if (/^\(.*\)$/.test(v)) {
    negative = true;
    v = v.slice(1, -1);
  }
  v = v.replace(/[^\d.,-]/g, "");
  if (v.startsWith("-")) {
    negative = !negative;
    v = v.slice(1);
  }
  if (!v) return null;
  const lastDot = v.lastIndexOf(".");
  const lastComma = v.lastIndexOf(",");
  const dots = (v.match(/\./g) ?? []).length;
  const commas = (v.match(/,/g) ?? []).length;
  let decimalSep: "." | "," | null;
  if (dots && commas) {
    decimalSep = lastDot > lastComma ? "." : ","; // the later separator is the decimal point
  } else if (commas) {
    // "12,50" → decimal; "1,234" / "1,234,567" → thousands
    decimalSep = commas === 1 && v.length - lastComma - 1 !== 3 ? "," : null;
  } else if (dots) {
    // "12.5" / "1234.56" → decimal; "1.234.567" → thousands
    decimalSep = dots === 1 ? "." : null;
  } else {
    decimalSep = null;
  }
  let major: string;
  let minor = "";
  if (decimalSep) {
    const at = v.lastIndexOf(decimalSep);
    major = v.slice(0, at).replace(/[.,]/g, "");
    minor = v.slice(at + 1).replace(/[.,]/g, "");
  } else {
    major = v.replace(/[.,]/g, "");
  }
  if (!/^\d*$/.test(major) || !/^\d*$/.test(minor)) return null;
  const cents = (minor + "00").slice(0, 2);
  const extra = minor.slice(2);
  let result = Number(major || "0") * 100 + Number(cents);
  if (extra && Number(extra[0]) >= 5) result += 1; // round half up on the 3rd decimal
  if (!Number.isFinite(result)) return null;
  return negative ? -result : result;
}

export function toNumber(raw: string): number | null {
  const v = raw.trim().replace(/[,\s]/g, "");
  if (!v) return null;
  const num = Number(v);
  return Number.isFinite(num) ? num : null;
}

export function toBoolean(raw: string): boolean | null {
  const v = raw.trim().toLowerCase();
  if (!v) return null;
  if (["true", "yes", "y", "1", "done", "x", "complete", "completed", "checked", "on"].includes(v)) return true;
  if (["false", "no", "n", "0", "open", "incomplete", "todo", "unchecked", "off", "pending"].includes(v)) return false;
  return null;
}

/** Normalise a date or datetime to ISO. Day-first is used when the first number cannot be a month. */
export function toIsoDate(raw: string, withTime: boolean): string | null {
  const v = raw.trim();
  if (!v) return null;
  let d: Date | null = null;
  const iso = v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  const slash = v.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (iso) {
    const [, y, m, dd, hh, mm, ss] = iso;
    if (hh !== undefined && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(v)) {
      // No zone given: treat the wall clock as UTC (never the server's zone,
      // which would shift a date-only import to the previous/next day).
      d = new Date(Date.UTC(+y, +m - 1, +dd, +hh, +mm, +(ss ?? 0)));
    } else if (hh !== undefined) {
      d = new Date(v);
    } else {
      d = new Date(Date.UTC(+y, +m - 1, +dd));
    }
  } else if (slash) {
    const [, a, b, yRaw, hh, mm, ss] = slash;
    const y = yRaw.length === 2 ? 2000 + +yRaw : +yRaw;
    let month = +a;
    let day = +b;
    if (month > 12 && day <= 12) [month, day] = [day, month];
    d = new Date(Date.UTC(y, month - 1, day, +(hh ?? 0), +(mm ?? 0), +(ss ?? 0)));
  } else {
    const t = Date.parse(v);
    if (!Number.isNaN(t)) d = new Date(t);
  }
  if (!d || Number.isNaN(d.getTime())) return null;
  return withTime ? d.toISOString() : d.toISOString().slice(0, 10);
}

export function toTags(raw: string): string[] {
  return Array.from(
    new Set(
      raw
        .split(/[,;|]/)
        .map((t) => t.trim())
        .filter(Boolean)
    )
  ).slice(0, 50);
}

export function coerceValue(raw: string, field: ImportField): { value: NormalisedRow[string]; error?: string } {
  const v = (raw ?? "").trim();
  if (v === "") return { value: null };
  switch (field.type) {
    case "string":
      return { value: v.slice(0, 5000) };
    case "email": {
      const e = v.toLowerCase();
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? { value: e } : { value: null, error: `"${v}" is not an email address` };
    }
    case "phone": {
      const digits = v.replace(/[^\d+]/g, "");
      return digits.length >= 6 ? { value: v.slice(0, 40) } : { value: null, error: `"${v}" is not a phone number` };
    }
    case "number": {
      const num = toNumber(v);
      return num === null ? { value: null, error: `"${v}" is not a number` } : { value: num };
    }
    case "money": {
      const minor = toMoneyMinor(v);
      return minor === null ? { value: null, error: `"${v}" is not an amount` } : { value: minor };
    }
    case "boolean": {
      const b = toBoolean(v);
      return b === null ? { value: null, error: `"${v}" is not yes/no` } : { value: b };
    }
    case "date":
    case "datetime": {
      const isoDate = toIsoDate(v, field.type === "datetime");
      return isoDate === null ? { value: null, error: `"${v}" is not a date` } : { value: isoDate };
    }
    case "enum": {
      const match = field.values?.find((o) => o.toLowerCase() === v.toLowerCase());
      if (match) return { value: match };
      // Loose match: "Customer (active)" → customer
      const loose = field.values?.find((o) => v.toLowerCase().includes(o.toLowerCase()));
      return loose ? { value: loose } : { value: null, error: `"${v}" is not one of ${field.values?.join(", ")}` };
    }
    case "tags":
      return { value: toTags(v) };
    default:
      return { value: v };
  }
}

// ── Run ──────────────────────────────────────────────────────────────────────

export function dedupeKeyFor(row: NormalisedRow, target: ImportTarget): string | null {
  if (target.dedupeKey.length === 0) return null;
  const parts = target.dedupeKey.map((k) => {
    const v = row[k];
    if (v === null || v === undefined) return "";
    return Array.isArray(v) ? v.join(",") : String(v);
  });
  if (parts.every((p) => p.trim() === "")) return null;
  return parts.join("|").toLowerCase();
}

export interface RunImportOptions {
  dryRun?: boolean;
  actorId?: string | null;
  fileName?: string | null;
  /** Skip the import_jobs row (tests). */
  recordJob?: boolean;
}

export async function runImport(
  dataId: string,
  target: ImportTarget,
  headers: string[],
  rows: string[][],
  mapping: Mapping,
  opts: RunImportOptions = {}
): Promise<ImportResult> {
  const dryRun = opts.dryRun ?? false;
  const errors: ImportError[] = [];
  const pushError = (e: ImportError) => {
    if (errors.length < MAX_ERRORS) errors.push(e);
  };

  if (rows.length > MAX_IMPORT_ROWS) {
    return { inserted: 0, skipped: 0, rowCount: rows.length, dryRun, jobId: null, errors: [{ row: 0, message: `Too many rows (max ${MAX_IMPORT_ROWS}).` }] };
  }

  const headerIndex = new Map(headers.map((h, i) => [h, i] as const));
  const fieldToIndex: Array<{ field: ImportField; index: number }> = [];
  for (const field of target.fields) {
    const header = mapping[field.key];
    if (!header) continue;
    const index = headerIndex.get(header);
    if (index === undefined) {
      pushError({ row: 0, field: field.key, message: `Mapped header "${header}" is not in the file.` });
      continue;
    }
    fieldToIndex.push({ field, index });
  }
  const missingRequired = target.fields.filter((f) => f.required && !mapping[f.key]);
  if (missingRequired.length) {
    return {
      inserted: 0,
      skipped: 0,
      rowCount: rows.length,
      dryRun,
      jobId: null,
      errors: [{ row: 0, message: `Required field(s) not mapped: ${missingRequired.map((f) => f.label).join(", ")}.` }, ...errors],
    };
  }

  if (!(await tableExists(target.table))) {
    return {
      inserted: 0,
      skipped: 0,
      rowCount: rows.length,
      dryRun,
      jobId: null,
      errors: [{ row: 0, message: `The ${target.label} table is not available in this workspace yet (migration ${target.table} missing).` }],
    };
  }

  let existing = new Set<string>();
  try {
    existing = await target.existingKeys(dataId);
  } catch (err) {
    console.warn(`[import] could not load existing ${target.key} keys:`, err instanceof Error ? err.message : err);
  }

  const seen = new Set<string>();
  // Keep the original 1-based CSV row number with each valid row: once skipped
  // rows are removed, an index into `valid` is no longer the file row.
  const valid: Array<{ row: NormalisedRow; rowNo: number }> = [];
  let skipped = 0;

  rows.forEach((raw, i) => {
    const rowNo = i + 1;
    const row: NormalisedRow = {};
    let bad = false;
    for (const { field, index } of fieldToIndex) {
      const { value, error } = coerceValue(raw[index] ?? "", field);
      if (error) {
        pushError({ row: rowNo, field: field.key, message: error });
        if (field.required) bad = true;
        continue;
      }
      row[field.key] = value;
    }
    for (const field of target.fields) {
      if (field.required && (row[field.key] === null || row[field.key] === undefined)) {
        pushError({ row: rowNo, field: field.key, message: `${field.label} is required.` });
        bad = true;
      }
    }
    if (bad) {
      skipped++;
      return;
    }
    const key = dedupeKeyFor(row, target);
    if (key) {
      if (existing.has(key)) {
        skipped++;
        pushError({ row: rowNo, message: `Duplicate of an existing record (${target.dedupeKey.join("+")}).` });
        return;
      }
      if (seen.has(key)) {
        skipped++;
        pushError({ row: rowNo, message: `Duplicate within the file (${target.dedupeKey.join("+")}).` });
        return;
      }
      seen.add(key);
    }
    valid.push({ row, rowNo });
  });

  let inserted = 0;
  if (!dryRun && valid.length) {
    // Chunked inserts; on a chunk failure fall back to per-row so errors are attributable.
    const CHUNK = 100;
    for (let i = 0; i < valid.length; i += CHUNK) {
      const slice = valid.slice(i, i + CHUNK);
      try {
        await target.insert(dataId, slice.map((v) => v.row));
        inserted += slice.length;
      } catch {
        for (const { row, rowNo } of slice) {
          try {
            await target.insert(dataId, [row]);
            inserted++;
          } catch (err) {
            skipped++;
            pushError({ row: rowNo, message: `Insert failed: ${(err instanceof Error ? err.message : String(err)).slice(0, 200)}` });
          }
        }
      }
    }
  } else if (dryRun) {
    inserted = valid.length; // "would insert"
  }

  let jobId: string | null = null;
  if (opts.recordJob !== false) {
    jobId = randomUUID();
    const status = dryRun ? "dry_run" : errors.some((e) => e.row === 0) ? "failed" : "done";
    await query(
      `INSERT INTO import_jobs (id, user_id, actor_id, target, status, dry_run, row_count, inserted, skipped, error_count, mapping, errors, file_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        jobId,
        dataId,
        opts.actorId ?? null,
        target.key,
        status,
        dryRun,
        rows.length,
        inserted,
        skipped,
        errors.length,
        JSON.stringify(mapping),
        JSON.stringify(errors.slice(0, 50)),
        opts.fileName ?? null,
      ]
    ).catch((err) => {
      console.warn("[import] could not record import job:", err instanceof Error ? err.message : err);
      jobId = null;
    });
  }

  return { inserted, skipped, errors, rowCount: rows.length, dryRun, jobId };
}

export interface ImportJobRow {
  id: string;
  target: string;
  status: string;
  dry_run: boolean;
  row_count: number;
  inserted: number;
  skipped: number;
  error_count: number;
  file_name: string | null;
  created_at: string;
}

export async function listImportJobs(dataId: string, limit = 50): Promise<ImportJobRow[]> {
  return query<ImportJobRow>(
    `SELECT id, target, status, dry_run, row_count, inserted, skipped, error_count, file_name, created_at
       FROM import_jobs WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [dataId, Math.max(1, Math.min(200, limit))]
  );
}
