/**
 * Workspace snapshots — client-safe types and pure helpers (no DB imports).
 *
 * A snapshot is a versioned, portable JSON document describing a workspace's
 * CONFIGURATION (never its data). Each section is optional and independently
 * selectable. See schema.ts for validation and sections.ts for the DB side.
 */

export const SNAPSHOT_SCHEMA_VERSION = 1;

/** Singleton sections hold one object; the rest hold arrays of items. */
export const SINGLETON_SECTIONS = ["settings", "branding", "storefront"] as const;

export const SECTION_KEYS = [
  "settings",
  "branding",
  "record_types",
  "tax_rates",
  "sla_policies",
  "automations",
  "agents",
  "playbook_settings",
  "kb_articles",
  "document_templates",
  "email_templates",
  "sequences",
  "audiences",
  "saved_reports",
  "dashboards",
  "storefront",
  "retention_policies",
  "privacy_notices",
] as const;
export type SectionKey = (typeof SECTION_KEYS)[number];

export function isSectionKey(v: unknown): v is SectionKey {
  return typeof v === "string" && (SECTION_KEYS as readonly string[]).includes(v);
}
export function isSingletonSection(k: SectionKey): boolean {
  return (SINGLETON_SECTIONS as readonly string[]).includes(k);
}

export const SECTION_LABELS: Record<SectionKey, string> = {
  settings: "Locale, currency, billing & privacy settings",
  branding: "Branding",
  record_types: "Record types",
  tax_rates: "Tax rates",
  sla_policies: "SLA policies",
  automations: "Automations (paused on apply)",
  agents: "AI agents (idle on apply)",
  playbook_settings: "Playbook settings",
  kb_articles: "Knowledge base (published)",
  document_templates: "Document templates",
  email_templates: "Email templates",
  sequences: "Sequences",
  audiences: "Audiences",
  saved_reports: "Saved reports",
  dashboards: "Dashboards",
  storefront: "Storefront settings",
  retention_policies: "Retention policies",
  privacy_notices: "Privacy notices (published)",
};

export const MAX_ITEMS_PER_SECTION = 500;
export const MAX_SNAPSHOT_BYTES = 5 * 1024 * 1024;

/** Things a snapshot must never contain, by name. Documented for the UI. */
export const NEVER_INCLUDED = [
  "contacts",
  "bookings",
  "invoices & payments",
  "messages",
  "tickets",
  "secrets, tokens & API keys",
  "OAuth connections",
  "webhook URLs",
] as const;

/* ─── Secret scanning (used on export AND import) ───────────────────────── */

/** Key names that indicate a credential. Matched case-insensitively on every object key. */
export const SECRET_KEY_RE =
  /(secret|passw(or)?d|passwd|pwd|passphrase|token|api[_-]?key|apikey|private[_-]?key|privatekey|credential|authoriz|(^|[_.-])auth($|[_.-])|bearer|cookie|session[_-]?(id|key|secret)|(^|[_.-])otp($|[_.-])|hmac|signature|refresh|access[_-]?(key|code)|webhook[_-]?(url|secret)|(^|[_.-])enc($|[_.-])|encrypted|_enc$|(^|[_.-])hash($|[_.-])|_hash$|key_hash|otp_hash)/i;
/** Object keys that can poison prototypes when merged or assigned downstream. */
export const FORBIDDEN_KEY_RE = /^(__proto__|constructor|prototype)$/;
/** Value shapes that look like credentials regardless of the key. */
export const SECRET_VALUE_RE = /(sk_(live|test)_[A-Za-z0-9]{8,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|xox[abprs]-[A-Za-z0-9-]{8,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,}|hooks\.slack\.com\/services)/;

/** Returns paths of suspicious keys/values (empty = clean). Walks arrays and objects. */
export function findSecretPaths(value: unknown, path = "$", out: string[] = [], depth = 0): string[] {
  if (out.length >= 50) return out;
  // Fail closed: content nested deeper than we scan could hide a credential.
  if (depth > 40) {
    out.push(`${path} (nested too deeply)`);
    return out;
  }
  if (typeof value === "string") {
    if (SECRET_VALUE_RE.test(value)) out.push(path);
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => findSecretPaths(v, `${path}[${i}]`, out, depth + 1));
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY_RE.test(k)) out.push(`${path}.${k}`);
      else findSecretPaths(v, `${path}.${k}`, out, depth + 1);
    }
  }
  return out;
}

/** Paths of prototype-pollution keys anywhere in a parsed document. */
export function findForbiddenKeys(value: unknown, path = "$", out: string[] = [], depth = 0): string[] {
  if (out.length >= 20 || depth > 41) return out;
  if (Array.isArray(value)) value.forEach((v, i) => findForbiddenKeys(v, `${path}[${i}]`, out, depth + 1));
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_KEY_RE.test(k)) out.push(`${path}.${k}`);
      else findForbiddenKeys(v, `${path}.${k}`, out, depth + 1);
    }
  }
  return out;
}

/* ─── Plan / result shapes ──────────────────────────────────────────────── */

export type ApplyMode = "merge" | "skip_existing";
export type PlanAction = "create" | "update" | "skip";

export interface PlanItem {
  key: string;
  action: PlanAction;
  /** Why: "exists", "unchanged", "not owned by a snapshot", … */
  reason?: string;
}
export interface SectionPlan {
  section: SectionKey;
  create: number;
  update: number;
  skip: number;
  conflicts: string[];
  items: PlanItem[];
}
export interface SnapshotPlan {
  mode: ApplyMode;
  sections: SectionPlan[];
  totals: { create: number; update: number; skip: number; conflicts: number };
}
export interface ApplyError {
  section: SectionKey;
  key: string;
  message: string;
}
export interface ApplyResult {
  application_id: string | null;
  status: "applied" | "partial" | "failed";
  plan: SnapshotPlan;
  created: number;
  updated: number;
  skipped: number;
  errors: ApplyError[];
}

export interface SnapshotMeta {
  id: string;
  name: string;
  description: string | null;
  sections: SectionKey[];
  sha256: string;
  size_bytes: number;
  source_org_id: string | null;
  visibility: "private" | "agency";
  created_by: string | null;
  created_at: string;
  /** "own" for this workspace's snapshots, "agency" for ones shared by the parent agency. */
  origin?: "own" | "agency";
}

export interface ApplicationDTO {
  id: string;
  snapshot_id: string | null;
  snapshot_name: string | null;
  applied_by: string | null;
  mode: string;
  status: string;
  created: number;
  updated: number;
  skipped: number;
  errors: number;
  created_at: string;
}
