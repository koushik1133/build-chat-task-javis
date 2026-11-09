import { getPath } from "./conditions";

/**
 * `{{ }}` template rendering (client-safe; the builder shows live previews).
 *
 *   {{entity.name}}                 → value at the dotted path ("" when missing)
 *   {{entity.name ?? "there"}}      → fallback when the path is null/undefined/""
 *   {{event.data.total_minor | money}}  → filters: money (minor units → 2dp), upper, lower, date, json
 *
 * `resolveTemplate` always returns a string. `renderValue` walks an object and
 * keeps the native type when a string is exactly one expression, so a tool
 * input like `{"qty": "{{event.data.qty}}"}` stays a number.
 */

const EXPR = /\{\{\s*([^{}]+?)\s*\}\}/g;
const SINGLE = /^\{\{\s*([^{}]+?)\s*\}\}$/;

export interface RenderOptions {
  /** HTML-escape every substituted value (for email bodies). */
  escapeHtml?: boolean;
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function stringify(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (v instanceof Date) return v.toISOString();
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function applyFilter(v: unknown, filter: string): unknown {
  switch (filter) {
    case "money": {
      const n = typeof v === "number" ? v : Number(v);
      return Number.isFinite(n) ? (n / 100).toFixed(2) : stringify(v);
    }
    case "upper":
      return stringify(v).toUpperCase();
    case "lower":
      return stringify(v).toLowerCase();
    case "date": {
      const t = typeof v === "number" ? v : Date.parse(stringify(v));
      return Number.isNaN(t) ? stringify(v) : new Date(t).toISOString().slice(0, 10);
    }
    case "json":
      return JSON.stringify(v ?? null);
    case "trim":
      return stringify(v).trim();
    default:
      return v;
  }
}

function parseLiteral(raw: string): unknown {
  const t = raw.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1);
  if (t === "true") return true;
  if (t === "false") return false;
  if (t === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  return undefined;
}

/** Evaluate one expression body (the part between the braces) to a raw value. */
export function evaluateExpression(expr: string, context: unknown): unknown {
  const [pathPart, ...filters] = expr.split("|").map((s) => s.trim());
  const [path, fallbackRaw] = pathPart.split("??").map((s) => s.trim());
  let v: unknown = getPath(context, path);
  if ((v === undefined || v === null || v === "") && fallbackRaw !== undefined) {
    const lit = parseLiteral(fallbackRaw);
    v = lit !== undefined ? lit : getPath(context, fallbackRaw);
  }
  for (const f of filters) v = applyFilter(v, f);
  return v;
}

export function resolveTemplate(template: string, context: unknown, opts: RenderOptions = {}): string {
  return template.replace(EXPR, (_m, expr: string) => {
    const s = stringify(evaluateExpression(expr, context));
    return opts.escapeHtml ? escapeHtml(s) : s;
  });
}

/** Recursively render strings inside any JSON value; single-expression strings keep their native type. */
export function renderValue<T>(value: T, context: unknown, opts: RenderOptions = {}): T {
  if (typeof value === "string") {
    const single = SINGLE.exec(value);
    if (single) {
      const v = evaluateExpression(single[1], context);
      if (typeof v === "string") return (opts.escapeHtml ? escapeHtml(v) : v) as unknown as T;
      return (v === undefined ? "" : v) as unknown as T;
    }
    return resolveTemplate(value, context, opts) as unknown as T;
  }
  if (Array.isArray(value)) return value.map((v) => renderValue(v, context, opts)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = renderValue(v, context, opts);
    return out as T;
  }
  return value;
}

/** Every `{{ }}` path referenced by a template (for the builder's "fields used" hints). */
export function referencedPaths(template: string): string[] {
  const out = new Set<string>();
  for (const m of template.matchAll(EXPR)) {
    const path = m[1].split("|")[0].split("??")[0].trim();
    if (path) out.add(path);
  }
  return [...out];
}
