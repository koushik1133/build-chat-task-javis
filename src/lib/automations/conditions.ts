import type { ConditionNode, ConditionRule, RunContext } from "./types";

/**
 * Pure condition evaluator (client-safe; the builder uses it for live preview).
 *
 * Fields are dotted paths over the run context: `event.data.total_minor`,
 * `entity.status`, `steps.enrich.score`. Missing paths resolve to `undefined`
 * and only satisfy `exists` (false) / `neq`. Groups: `{all: [...]}` is AND,
 * `{any: [...]}` is OR; both keys on one node are AND-ed together. An empty
 * group (or `null` conditions) is true.
 */

export function getPath(root: unknown, path: string): unknown {
  if (!path) return root;
  let cur: unknown = root;
  for (const raw of path.split(".")) {
    const key = raw.trim();
    if (key === "") continue;
    if (cur == null) return undefined;
    if (Array.isArray(cur)) {
      const idx = Number(key);
      cur = Number.isInteger(idx) ? cur[idx] : undefined;
      continue;
    }
    if (typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

function isRule(node: ConditionNode): node is ConditionRule {
  return typeof (node as ConditionRule).op === "string" && typeof (node as ConditionRule).field === "string";
}

function toNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : t;
  }
  if (v instanceof Date) return v.getTime();
  if (typeof v === "boolean") return v ? 1 : 0;
  return null;
}

function looseEq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return a == null && b == null;
  if (typeof a === "object" || typeof b === "object") {
    try {
      return JSON.stringify(a) === JSON.stringify(b);
    } catch {
      return false;
    }
  }
  return String(a).toLowerCase() === String(b).toLowerCase();
}

function compare(a: unknown, b: unknown): number | null {
  const na = toNumber(a);
  const nb = toNumber(b);
  if (na !== null && nb !== null) return na - nb;
  if (typeof a === "string" && typeof b === "string") return a.localeCompare(b);
  return null;
}

export function evaluateRule(rule: ConditionRule, context: RunContext | Record<string, unknown>): boolean {
  const actual = getPath(context, rule.field);
  const expected = rule.value;
  switch (rule.op) {
    case "exists":
      return expected === false ? actual == null : actual != null;
    case "eq":
      return looseEq(actual, expected);
    case "neq":
      return !looseEq(actual, expected);
    case "contains": {
      if (actual == null) return false;
      if (Array.isArray(actual)) return actual.some((x) => looseEq(x, expected));
      if (typeof actual === "object") return expected != null && Object.prototype.hasOwnProperty.call(actual, String(expected));
      return String(actual).toLowerCase().includes(String(expected ?? "").toLowerCase());
    }
    case "in": {
      const list = Array.isArray(expected) ? expected : typeof expected === "string" ? expected.split(",").map((s) => s.trim()) : [expected];
      return list.some((x) => looseEq(actual, x));
    }
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      const c = compare(actual, expected);
      if (c === null) return false;
      if (rule.op === "gt") return c > 0;
      if (rule.op === "gte") return c >= 0;
      if (rule.op === "lt") return c < 0;
      return c <= 0;
    }
    case "changed_to": {
      // True when the field now equals `value` and the event carries a different previous value
      // (`event.data.from` / `event.data.previous`) — or no previous value at all.
      if (!looseEq(actual, expected)) return false;
      const data = getPath(context, "event.data") as Record<string, unknown> | undefined;
      const prev = data?.from ?? data?.previous ?? data?.old;
      return prev === undefined || !looseEq(prev, expected);
    }
    default:
      return false;
  }
}

export function evaluateConditions(conditions: ConditionNode | null | undefined, context: RunContext | Record<string, unknown>): boolean {
  if (!conditions) return true;
  if (isRule(conditions)) return evaluateRule(conditions, context);
  const all = conditions.all ?? [];
  const any = conditions.any ?? [];
  const allOk = all.every((n) => evaluateConditions(n, context));
  const anyOk = any.length === 0 ? true : any.some((n) => evaluateConditions(n, context));
  return allOk && anyOk;
}

/** Flatten the leaf paths of an object into dotted field suggestions (for the builder's autocomplete). */
export function listPaths(root: unknown, prefix = "", depth = 0, out: string[] = []): string[] {
  if (depth > 4 || root == null) return out;
  if (typeof root !== "object" || Array.isArray(root)) {
    if (prefix) out.push(prefix);
    return out;
  }
  const entries = Object.entries(root as Record<string, unknown>);
  if (entries.length === 0 && prefix) out.push(prefix);
  for (const [k, v] of entries) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === "object" && !Array.isArray(v)) listPaths(v, p, depth + 1, out);
    else out.push(p);
  }
  return out;
}
