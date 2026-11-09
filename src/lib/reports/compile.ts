import { DATE_BUCKETS, type Aggregation, type Dataset, type DatasetField, type DateBucket, fieldByKey } from "./datasets";
import { DEFAULT_REPORT_ROWS, MAX_REPORT_ROWS, type ReportFilter, type ReportSpec } from "./spec";
import { parseDateInput, resolvePreset } from "./dates";

/**
 * Pure report compiler: ReportSpec + Dataset → parameterised SQL.
 *
 * Identifier safety: every table/column/expression comes from the dataset
 * definition; user input only ever lands in `values`. Unknown field keys,
 * disallowed aggregations and bad operators throw ReportSpecError.
 */

export class ReportSpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReportSpecError";
  }
}

export interface OutputColumn {
  key: string;
  label: string;
  kind: "dimension" | "measure" | "date";
  format: DatasetField["format"] | null;
  /** Source field key (for chart hints). */
  field: string | null;
  agg: Aggregation | null;
  bucket: DateBucket | null;
}

export interface CompiledReport {
  sql: string;
  values: unknown[];
  totalsSql: string | null;
  totalsValues: unknown[];
  columns: OutputColumn[];
  mode: "aggregate" | "raw";
  limit: number;
}

export interface CompileContext {
  dataId: string;
  timeZone: string;
  now?: Date;
  /** records datasets: the type id bound to `{{type_id}}`. */
  recordTypeId?: string | null;
}

const IDENT_RE = /^[a-z][a-z0-9_]*$/;

class Params {
  readonly values: unknown[] = [];
  add(v: unknown): string {
    this.values.push(v);
    return `$${this.values.length}`;
  }
}

/** SQL expression for a field (JSON fields bind their key as a parameter). `::json` (not jsonb): DSQL supports json/jsonb only as runtime types; ->> behaves identically for flat key lookups. */
function fieldExpr(f: DatasetField, p: Params): string {
  if (f.column) return f.column;
  if (!f.jsonKey || !IDENT_RE.test(f.jsonKey)) throw new ReportSpecError(`Field ${f.key} has no column`);
  const base = `(data::json ->> ${p.add(f.jsonKey)})`;
  if (f.kind === "measure") return `NULLIF(${base}, '')::numeric`;
  if (f.kind === "date") return `NULLIF(${base}, '')::timestamptz`;
  return base;
}

function bucketExpr(expr: string, bucket: DateBucket, tzParam: string): string {
  const local = `(${expr} AT TIME ZONE ${tzParam})`;
  switch (bucket) {
    case "day": return `to_char(date_trunc('day', ${local}), 'YYYY-MM-DD')`;
    case "week": return `to_char(date_trunc('week', ${local}), 'YYYY-MM-DD')`;
    case "month": return `to_char(date_trunc('month', ${local}), 'YYYY-MM')`;
    case "quarter": return `to_char(date_trunc('quarter', ${local}), 'YYYY-"Q"Q')`;
    case "year": return `to_char(date_trunc('year', ${local}), 'YYYY')`;
  }
}

function aggExpr(agg: Aggregation, expr: string | null): string {
  switch (agg) {
    case "count": return expr ? `COUNT(${expr})` : "COUNT(*)";
    case "count_distinct": return `COUNT(DISTINCT ${expr ?? "1"})`;
    case "sum": return `COALESCE(SUM(${expr}), 0)`;
    case "avg": return `AVG(${expr})`;
    case "min": return `MIN(${expr})`;
    case "max": return `MAX(${expr})`;
  }
}

function allowedAggs(f: DatasetField): readonly Aggregation[] {
  return f.aggregations ?? (f.kind === "dimension" ? ["count", "count_distinct"] : ["sum", "avg", "min", "max", "count", "count_distinct"]);
}

function requireField(ds: Dataset, key: string): DatasetField {
  const f = fieldByKey(ds, key);
  if (!f) throw new ReportSpecError(`Unknown field "${key.slice(0, 80)}" for dataset ${ds.key}`);
  return f;
}

function scalarValue(v: unknown, f: DatasetField, ctx: CompileContext): unknown {
  if (v === null || v === undefined) return null;
  if (f.kind === "date") {
    const d = typeof v === "string" ? parseDateInput(v, ctx.timeZone) : v instanceof Date ? v : null;
    if (!d) throw new ReportSpecError(`Filter on ${f.key} needs a date`);
    return d.toISOString();
  }
  if (f.kind === "measure") {
    const n = typeof v === "number" ? v : Number(v);
    if (!Number.isFinite(n)) throw new ReportSpecError(`Filter on ${f.key} needs a number`);
    return n;
  }
  return typeof v === "string" ? v : String(v);
}

function isDateRange(v: unknown): v is { preset?: string; from?: string | null; to?: string | null } {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

function compileFilter(ds: Dataset, flt: ReportFilter, p: Params, ctx: CompileContext): string | null {
  const f = requireField(ds, flt.field);
  const col = fieldExpr(f, p);
  const v = flt.value;
  switch (flt.op) {
    case "is_null": return `${col} IS NULL`;
    case "not_null": return `${col} IS NOT NULL`;
    case "eq": {
      const s = scalarValue(v, f, ctx);
      return s === null ? `${col} IS NULL` : `${col} = ${p.add(s)}`;
    }
    case "neq": {
      const s = scalarValue(v, f, ctx);
      return s === null ? `${col} IS NOT NULL` : `${col} <> ${p.add(s)}`;
    }
    case "in":
    case "not_in": {
      const arr = (Array.isArray(v) ? v : [v]).filter((x) => x !== null && x !== undefined).map((x) => scalarValue(x, f, ctx));
      if (arr.length === 0) return flt.op === "in" ? "FALSE" : "TRUE";
      const cast = f.kind === "measure" ? "::numeric[]" : f.kind === "date" ? "::timestamptz[]" : "::text[]";
      return `${col} ${flt.op === "in" ? "=" : "<>"} ${flt.op === "in" ? "ANY" : "ALL"}(${p.add(arr.map((x) => (f.kind === "measure" ? x : String(x))))}${cast})`;
    }
    case "contains": {
      if (f.kind !== "dimension") throw new ReportSpecError(`contains only applies to text fields (${f.key})`);
      const s = String(v ?? "").replace(/[\\%_]/g, (c) => `\\${c}`);
      return `${col} ILIKE ${p.add(`%${s}%`)}`;
    }
    case "gt": return `${col} > ${p.add(scalarValue(v, f, ctx))}`;
    case "gte": return `${col} >= ${p.add(scalarValue(v, f, ctx))}`;
    case "lt": return `${col} < ${p.add(scalarValue(v, f, ctx))}`;
    case "lte": return `${col} <= ${p.add(scalarValue(v, f, ctx))}`;
    case "between": {
      if (!Array.isArray(v) || v.length !== 2) throw new ReportSpecError(`between needs [from, to] (${f.key})`);
      const hi = f.kind === "date" && typeof v[1] === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v[1]) ? parseDateInput(v[1], ctx.timeZone, true)?.toISOString() : scalarValue(v[1], f, ctx);
      return `${col} >= ${p.add(scalarValue(v[0], f, ctx))} AND ${col} ${f.kind === "date" ? "<" : "<="} ${p.add(hi)}`;
    }
    case "date_range": {
      if (f.kind !== "date") throw new ReportSpecError(`date_range only applies to date fields (${f.key})`);
      if (!isDateRange(v)) throw new ReportSpecError(`date_range needs {preset} or {from, to}`);
      const now = ctx.now ?? new Date();
      if (typeof v.preset === "string") {
        const r = resolvePreset(v.preset as Parameters<typeof resolvePreset>[0], now, ctx.timeZone);
        return `${col} >= ${p.add(r.from.toISOString())} AND ${col} < ${p.add(r.to.toISOString())}`;
      }
      const parts: string[] = [];
      const from = parseDateInput(v.from ?? null, ctx.timeZone);
      const to = parseDateInput(v.to ?? null, ctx.timeZone, true);
      if (from) parts.push(`${col} >= ${p.add(from.toISOString())}`);
      if (to) parts.push(`${col} < ${p.add(to.toISOString())}`);
      return parts.length ? parts.join(" AND ") : null;
    }
  }
}

function baseWhere(ds: Dataset, p: Params, ctx: CompileContext): string[] {
  const where = [`${ds.scopeColumn} = ${p.add(ctx.dataId)}`];
  if (ds.deletedColumn) where.push(`${ds.deletedColumn} IS NULL`);
  if (ds.where) {
    if (ds.where.includes("{{type_id}}")) {
      if (!ctx.recordTypeId) throw new ReportSpecError("records dataset needs a record type");
      where.push(ds.where.replace("{{type_id}}", p.add(ctx.recordTypeId)));
    } else where.push(ds.where);
  }
  return where;
}

export function compileReport(ds: Dataset, spec: ReportSpec, ctx: CompileContext): CompiledReport {
  const p = new Params();
  const where = baseWhere(ds, p, ctx);
  for (const flt of spec.filters) {
    const w = compileFilter(ds, flt, p, ctx);
    if (w) where.push(w);
  }
  const limit = Math.max(1, Math.min(MAX_REPORT_ROWS, spec.limit ?? DEFAULT_REPORT_ROWS));
  const aggregate = spec.measures.length > 0 || spec.group_by.length > 0;
  const columns: OutputColumn[] = [];
  const select: string[] = [];
  const groupBy: string[] = [];
  const seen = new Set<string>();
  const uniq = (key: string) => {
    let k = key;
    let i = 2;
    while (seen.has(k)) k = `${key}_${i++}`;
    seen.add(k);
    return k;
  };

  if (aggregate) {
    const tzParam = spec.group_by.some((g) => g.bucket) ? p.add(ctx.timeZone) : null;
    for (const g of spec.group_by) {
      const f = requireField(ds, g.field);
      let expr = fieldExpr(f, p);
      let key = f.key;
      let bucket: DateBucket | null = null;
      if (g.bucket) {
        if (f.kind !== "date") throw new ReportSpecError(`Only date fields can be bucketed (${f.key})`);
        if (!DATE_BUCKETS.includes(g.bucket)) throw new ReportSpecError(`Unknown bucket`);
        expr = bucketExpr(expr, g.bucket, tzParam ?? p.add(ctx.timeZone));
        key = `${f.key}_${g.bucket}`;
        bucket = g.bucket;
      } else if (f.kind === "date") {
        expr = `to_char(${expr} AT TIME ZONE ${tzParam ?? p.add(ctx.timeZone)}, 'YYYY-MM-DD')`;
      }
      key = uniq(key);
      select.push(`${expr} AS "${key}"`);
      groupBy.push(String(select.length));
      columns.push({ key, label: bucket ? `${f.label} (${bucket})` : f.label, kind: bucket ? "date" : f.kind, format: f.format ?? null, field: f.key, agg: null, bucket });
    }
    const measures = spec.measures.length > 0 ? spec.measures : [{ agg: "count" as const, field: undefined, label: undefined }];
    for (const m of measures) {
      const f = m.field ? requireField(ds, m.field) : null;
      if (f && !allowedAggs(f).includes(m.agg)) throw new ReportSpecError(`${m.agg} is not allowed on ${f.key}`);
      if (!f && m.agg !== "count") throw new ReportSpecError(`${m.agg} needs a field`);
      const key = uniq(f ? `${m.agg}_${f.key}` : "count");
      select.push(`${aggExpr(m.agg, f ? fieldExpr(f, p) : null)} AS "${key}"`);
      const label = m.label?.trim() || (f ? `${m.agg === "count_distinct" ? "Distinct" : m.agg.replace(/^\w/, (c) => c.toUpperCase())} ${f.label}` : "Count");
      const format = m.agg === "count" || m.agg === "count_distinct" ? "number" : (f?.format ?? "number");
      columns.push({ key, label, kind: "measure", format, field: f?.key ?? null, agg: m.agg, bucket: null });
    }
  } else {
    const keys = spec.columns && spec.columns.length > 0 ? spec.columns : ds.fields.slice(0, 8).map((f) => f.key);
    for (const k of keys) {
      const f = requireField(ds, k);
      const key = uniq(f.key);
      select.push(`${fieldExpr(f, p)} AS "${key}"`);
      columns.push({ key, label: f.label, kind: f.kind, format: f.format ?? null, field: f.key, agg: null, bucket: null });
    }
  }

  const colKeys = new Set(columns.map((c) => c.key));
  const order: string[] = [];
  for (const s of spec.sort ?? []) {
    if (!colKeys.has(s.by)) throw new ReportSpecError(`Cannot sort by "${s.by.slice(0, 80)}"`);
    order.push(`"${s.by}" ${s.dir === "asc" ? "ASC" : "DESC"} NULLS LAST`);
  }
  if (order.length === 0) {
    if (aggregate && groupBy.length > 0) order.push(...groupBy.map((g) => `${g} ASC`));
    else if (aggregate) { /* single totals row */ }
    else {
      const dateField = fieldByKey(ds, ds.defaultDate);
      if (dateField) order.push(`${fieldExpr(dateField, p)} DESC`);
    }
  }

  const sql = `SELECT ${select.join(", ")} FROM ${ds.from} WHERE ${where.join(" AND ")}${groupBy.length ? ` GROUP BY ${groupBy.join(", ")}` : ""}${order.length ? ` ORDER BY ${order.join(", ")}` : ""} LIMIT ${p.add(limit)}`;

  let totalsSql: string | null = null;
  let totalsValues: unknown[] = [];
  if (aggregate && groupBy.length > 0) {
    const tp = new Params();
    const tw = baseWhere(ds, tp, ctx);
    for (const flt of spec.filters) {
      const w = compileFilter(ds, flt, tp, ctx);
      if (w) tw.push(w);
    }
    const tsel = columns
      .filter((c) => c.kind === "measure" && c.agg)
      .map((c) => `${aggExpr(c.agg as Aggregation, c.field ? fieldExpr(requireField(ds, c.field), tp) : null)} AS "${c.key}"`);
    totalsSql = `SELECT ${tsel.join(", ")} FROM ${ds.from} WHERE ${tw.join(" AND ")}`;
    totalsValues = tp.values;
  }

  return { sql, values: p.values, totalsSql, totalsValues, columns, mode: aggregate ? "aggregate" : "raw", limit };
}
