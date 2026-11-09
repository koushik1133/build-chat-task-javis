import { createHash } from "crypto";

/**
 * Pure anonymisation helpers. Given rows → anonymised rows; no DB access so
 * the behaviour is unit-testable and the same rules apply everywhere.
 */

export const ERASED_NAME = "Erased";
export const ERASED_CUSTOMER_LABEL = "Erased customer";
export const REDACTED = "[redacted]";

/** Stable sha256 tombstone of a normalised identifier (lower-cased email or digits-only phone). */
export function tombstoneHash(value: string): string {
  return createHash("sha256").update(normalizeIdentifier(value), "utf8").digest("hex");
}

export function normalizeIdentifier(value: string): string {
  const v = value.trim().toLowerCase();
  if (v.includes("@")) return v;
  const digits = v.replace(/[^0-9+]/g, "");
  return digits || v;
}

/** Column classes drive the replacement value. */
export type PiiClass = "name" | "email" | "phone" | "free_text" | "json" | "label";

export interface AnonymizeSpec {
  [column: string]: PiiClass;
}

const NAME_COLUMNS = new Set(["full_name", "name", "requester_name", "first_name", "accepted_name", "display_name"]);
const EMAIL_COLUMNS = new Set(["email", "requester_email", "from_addr", "accepted_email"]);
const PHONE_COLUMNS = new Set(["phone", "from_number"]);
const TEXT_COLUMNS = new Set(["notes", "body", "body_text", "body_html", "snippet", "subject", "transcript", "research_summary", "summary", "description", "ip", "user_agent"]);
const JSON_COLUMNS = new Set(["data", "messages", "to_addrs"]);

/** Infer PII class from a column name; null = not personal data (left untouched). */
export function classifyColumn(column: string): PiiClass | null {
  if (NAME_COLUMNS.has(column)) return "name";
  if (EMAIL_COLUMNS.has(column)) return "email";
  if (PHONE_COLUMNS.has(column)) return "phone";
  if (TEXT_COLUMNS.has(column)) return "free_text";
  if (JSON_COLUMNS.has(column)) return "json";
  return null;
}

export function replacementFor(cls: PiiClass, column: string): unknown {
  switch (cls) {
    case "name":
      return column === "full_name" ? ERASED_NAME : ERASED_CUSTOMER_LABEL;
    case "label":
      return ERASED_CUSTOMER_LABEL;
    case "email":
    case "phone":
      return null;
    case "free_text":
      return REDACTED;
    case "json":
      return column === "to_addrs" || column === "messages" ? "[]" : "{}";
  }
}

/**
 * Anonymise one row. `spec` overrides inferred classes; columns not personal
 * data are preserved (ids, amounts, timestamps, statuses).
 */
export function anonymizeRow<T extends Record<string, unknown>>(row: T, spec: AnonymizeSpec = {}): T {
  const out: Record<string, unknown> = { ...row };
  for (const col of Object.keys(row)) {
    const cls = spec[col] ?? classifyColumn(col);
    if (!cls) continue;
    if (row[col] === null || row[col] === undefined) continue;
    out[col] = replacementFor(cls, col);
  }
  return out as T;
}

export function anonymizeRows<T extends Record<string, unknown>>(rows: T[], spec: AnonymizeSpec = {}): T[] {
  return rows.map((r) => anonymizeRow(r, spec));
}

/** Tombstones for every identifier the subject had (dedupe, skip blanks). */
export function tombstonesFor(identifiers: Array<string | null | undefined>): string[] {
  const out = new Set<string>();
  for (const v of identifiers) if (v && v.trim()) out.add(tombstoneHash(v));
  return [...out];
}

/* ---------- export whitelist guard ---------- */

const INTERNAL_KEYS = new Set(["user_id", "owner_user_id", "actor_id", "assigned_to", "created_by", "handled_by", "author_id", "token_hash", "otp_hash", "export_token_hash", "cancel_token_hash", "auth", "secret"]);

/** Deep-strip internal/staff identifiers from an export bundle. Pure. */
export function stripInternalKeys<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => stripInternalKeys(v)) as unknown as T;
  if (value && typeof value === "object" && !(value instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (INTERNAL_KEYS.has(k)) continue;
      out[k] = stripInternalKeys(v);
    }
    return out as T;
  }
  return value;
}

/** All object keys (recursive) — used by tests to assert nothing internal leaks. */
export function collectKeys(value: unknown, acc = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const v of value) collectKeys(v, acc);
  else if (value && typeof value === "object" && !(value instanceof Date)) {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      acc.add(k);
      collectKeys(v, acc);
    }
  }
  return acc;
}
