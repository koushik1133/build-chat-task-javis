import { query, queryOne } from "@/lib/dsql";
import { parseOrgSettings } from "@/lib/org-settings";
import { isCurrencyCode } from "@/lib/i18n/format";
import type { RoundingMode } from "./tax";

/**
 * Billing preferences stored alongside the other org settings in
 * `organizations.settings` (JSON TEXT). Unknown keys are preserved.
 */
export interface BillingSettings {
  /** Label for the org's own tax registration, e.g. "VAT ID", "GSTIN". */
  tax_id_label: string | null;
  tax_number: string | null;
  prices_include_tax: boolean;
  tax_rounding: RoundingMode;
  /** Default payment terms in days (used when an invoice has none). */
  default_terms_days: number;
  /** Reminder offsets in days relative to the due date (negative = before). */
  dunning_schedule: number[];
  quote_prefix: string;
  invoice_prefix: string;
  credit_note_prefix: string;
  /** Currency the home/reporting tiles convert into; null = per currency. */
  reporting_currency: string | null;
}

export const DEFAULT_DUNNING_SCHEDULE: readonly number[] = [-3, 0, 7, 14, 30];

export const DEFAULT_BILLING_SETTINGS: BillingSettings = {
  tax_id_label: null,
  tax_number: null,
  prices_include_tax: false,
  tax_rounding: "per_line",
  default_terms_days: 14,
  dunning_schedule: [...DEFAULT_DUNNING_SCHEDULE],
  quote_prefix: "Q",
  invoice_prefix: "INV",
  credit_note_prefix: "CN",
  reporting_currency: null,
};

const PREFIX_RE = /^[A-Z0-9]{1,8}$/;

function str(v: unknown, max = 200): string | null {
  return typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;
}

function prefix(v: unknown, fallback: string): string {
  const s = typeof v === "string" ? v.trim().toUpperCase() : "";
  return PREFIX_RE.test(s) ? s : fallback;
}

/** Typed view of the billing keys with defaults applied (pure). */
export function toBillingSettings(raw: Record<string, unknown>): BillingSettings {
  const sched = Array.isArray(raw.dunning_schedule)
    ? Array.from(new Set(raw.dunning_schedule.map(Number).filter((n) => Number.isInteger(n) && n >= -60 && n <= 365))).sort((a, b) => a - b)
    : null;
  const terms = Number(raw.default_terms_days);
  const rc = typeof raw.reporting_currency === "string" ? raw.reporting_currency.toUpperCase() : null;
  return {
    tax_id_label: str(raw.tax_id_label, 40),
    tax_number: str(raw.tax_number, 64),
    prices_include_tax: raw.prices_include_tax === true,
    tax_rounding: raw.tax_rounding === "per_total" ? "per_total" : "per_line",
    default_terms_days: Number.isInteger(terms) && terms >= 0 && terms <= 365 ? terms : DEFAULT_BILLING_SETTINGS.default_terms_days,
    dunning_schedule: sched && sched.length > 0 ? sched : [...DEFAULT_DUNNING_SCHEDULE],
    quote_prefix: prefix(raw.quote_prefix, "Q"),
    invoice_prefix: prefix(raw.invoice_prefix, "INV"),
    credit_note_prefix: prefix(raw.credit_note_prefix, "CN"),
    reporting_currency: rc && isCurrencyCode(rc) ? rc : null,
  };
}

export async function getBillingSettings(dataId: string): Promise<BillingSettings> {
  const row = await queryOne<{ settings: string | null }>(`SELECT settings FROM organizations WHERE owner_user_id = $1`, [dataId]).catch(() => null);
  return toBillingSettings(parseOrgSettings(row?.settings));
}

const KEYS: ReadonlyArray<keyof BillingSettings> = [
  "tax_id_label", "tax_number", "prices_include_tax", "tax_rounding", "default_terms_days", "dunning_schedule",
  "quote_prefix", "invoice_prefix", "credit_note_prefix", "reporting_currency",
];

/** Merge billing keys into the stored JSON; other keys untouched. */
export async function updateBillingSettings(dataId: string, patch: Partial<BillingSettings>): Promise<BillingSettings> {
  const row = await queryOne<{ settings: string | null }>(`SELECT settings FROM organizations WHERE owner_user_id = $1`, [dataId]);
  const next: Record<string, unknown> = { ...parseOrgSettings(row?.settings) };
  for (const k of KEYS) if (patch[k] !== undefined) next[k] = patch[k];
  const typed = toBillingSettings(next);
  for (const k of KEYS) next[k] = typed[k];
  await query(`UPDATE organizations SET settings = $2, updated_at = NOW() WHERE owner_user_id = $1`, [dataId, JSON.stringify(next)]);
  return typed;
}
