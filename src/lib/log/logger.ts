import { redactForLog } from "@/lib/ai/output-guard";
import { getRequestContext } from "./context";

/**
 * Structured JSON logger. One line per event:
 *   {ts, level, msg, req_id, org, route, ms, err, ...extra}
 * `LOG_LEVEL` = debug|info|warn|error|silent (default info; warn in tests).
 * Dev (non-production) prints a readable single line instead of JSON.
 * Every string value is passed through `redactForLog` (emails, phones, keys, tokens).
 */

export type LogLevel = "debug" | "info" | "warn" | "error";
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LogFields {
  ms?: number;
  err?: unknown;
  route?: string;
  [key: string]: unknown;
}

export function configuredLevel(env: Record<string, string | undefined> = process.env): number {
  const raw = (env.LOG_LEVEL ?? "").trim().toLowerCase();
  if (raw === "silent" || raw === "off") return Infinity;
  if (Object.prototype.hasOwnProperty.call(ORDER, raw)) return ORDER[raw as LogLevel];
  return env.NODE_ENV === "test" ? ORDER.warn : ORDER.info;
}

const SENSITIVE_KEY = /pass(word)?|secret|token|authorization|cookie|api[_-]?key|card|ssn/i;

function scrub(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return redactForLog(value.length > 1000 ? `${value.slice(0, 1000)}…` : value);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function" || typeof value === "symbol") return `[${typeof value}]`;
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (value instanceof Error) return errString(value);
  if (depth >= 3) return "[object]";
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => scrub(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = SENSITIVE_KEY.test(k) ? "[redacted]" : scrub(v, depth + 1);
  return out;
}

function errString(err: unknown): string {
  if (err instanceof Error) return redactForLog(`${err.name}: ${err.message}`).slice(0, 500);
  if (typeof err === "string") return redactForLog(err).slice(0, 500);
  try { return redactForLog(JSON.stringify(err)).slice(0, 500); } catch { return "unknown error"; }
}

/** Pure: build the structured record. */
export function buildRecord(level: LogLevel, msg: string, fields: LogFields = {}, now: Date = new Date()): Record<string, unknown> {
  const ctx = getRequestContext();
  const { err, ms, route, ...extra } = fields;
  const rec: Record<string, unknown> = { ts: now.toISOString(), level, msg: redactForLog(msg) };
  if (ctx) rec.req_id = ctx.reqId;
  if (ctx?.org) rec.org = ctx.org;
  const r = route ?? ctx?.route;
  if (r) rec.route = r;
  if (typeof ms === "number") rec.ms = Math.round(ms);
  if (err !== undefined) rec.err = errString(err);
  for (const [k, v] of Object.entries(extra)) {
    if (k in rec) continue;
    rec[k] = SENSITIVE_KEY.test(k) ? "[redacted]" : scrub(v);
  }
  return rec;
}

export function formatRecord(rec: Record<string, unknown>, pretty: boolean): string {
  if (!pretty) return JSON.stringify(rec);
  const { ts, level, msg, ...rest } = rec;
  const tail = Object.keys(rest).length ? ` ${JSON.stringify(rest)}` : "";
  return `${String(ts).slice(11, 23)} ${String(level).toUpperCase().padEnd(5)} ${String(msg)}${tail}`;
}

function emit(level: LogLevel, msg: string, fields?: LogFields): void {
  if (ORDER[level] < configuredLevel()) return;
  let line: string;
  try {
    line = formatRecord(buildRecord(level, msg, fields), process.env.NODE_ENV !== "production" && process.env.LOG_FORMAT !== "json");
  } catch {
    return; // logging must never throw into the request path
  }
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const logger = {
  debug: (msg: string, fields?: LogFields) => emit("debug", msg, fields),
  info: (msg: string, fields?: LogFields) => emit("info", msg, fields),
  warn: (msg: string, fields?: LogFields) => emit("warn", msg, fields),
  error: (msg: string, fields?: LogFields) => emit("error", msg, fields),
};
