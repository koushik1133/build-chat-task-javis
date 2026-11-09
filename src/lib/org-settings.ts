import { query, queryOne } from "@/lib/dsql";
import { requestMemo } from "@/lib/request-cache";
import { DEFAULT_LOCALE, isLocale, type Locale } from "@/lib/i18n";
import { DEFAULT_CURRENCY, isCurrencyCode, isValidTimeZone } from "@/lib/i18n/format";

/**
 * Org-level preferences stored in `organizations.settings` (JSON TEXT).
 * Keyed by the org data id (owner_user_id) like every other module.
 * Unknown keys written by other features are preserved on update.
 */
export interface OrgSettings {
  locale: Locale;
  currency: string;
  timezone: string;
}

export const DEFAULT_ORG_SETTINGS: OrgSettings = {
  locale: DEFAULT_LOCALE,
  currency: DEFAULT_CURRENCY,
  timezone: "UTC",
};

export function parseOrgSettings(json: string | null | undefined): Record<string, unknown> {
  if (!json) return {};
  try {
    const v = JSON.parse(json) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Typed view with defaults applied; invalid stored values fall back. */
export function toOrgSettings(raw: Record<string, unknown>): OrgSettings {
  return {
    locale: isLocale(raw.locale) ? raw.locale : DEFAULT_ORG_SETTINGS.locale,
    currency: isCurrencyCode(raw.currency) ? String(raw.currency).toUpperCase() : DEFAULT_ORG_SETTINGS.currency,
    timezone: isValidTimeZone(raw.timezone) ? raw.timezone : DEFAULT_ORG_SETTINGS.timezone,
  };
}

/** Uncached loader (exported for tests); callers use `getOrgSettings`. */
export async function loadOrgSettings(dataId: string): Promise<OrgSettings> {
  const row = await queryOne<{ settings: string | null }>(
    `SELECT settings FROM organizations WHERE owner_user_id = $1`,
    [dataId]
  ).catch(() => null);
  return toOrgSettings(parseOrgSettings(row?.settings));
}

/**
 * Per-request memoised: the (app) layout, `getRequestLocale()` and the home
 * summary all read org settings in the same render, so the SELECT runs once.
 */
export const getOrgSettings: (dataId: string) => Promise<OrgSettings> = requestMemo(loadOrgSettings);

/** Merge `patch` into the stored JSON (other keys untouched) and return the new typed view. */
export async function updateOrgSettings(dataId: string, patch: Partial<OrgSettings>): Promise<OrgSettings> {
  const row = await queryOne<{ settings: string | null }>(
    `SELECT settings FROM organizations WHERE owner_user_id = $1`,
    [dataId]
  );
  const current = parseOrgSettings(row?.settings);
  const next: Record<string, unknown> = { ...current };
  if (patch.locale !== undefined) next.locale = patch.locale;
  if (patch.currency !== undefined) next.currency = patch.currency.toUpperCase();
  if (patch.timezone !== undefined) next.timezone = patch.timezone;
  await query(`UPDATE organizations SET settings = $2, updated_at = NOW() WHERE owner_user_id = $1`, [
    dataId,
    JSON.stringify(next),
  ]);
  return toOrgSettings(next);
}
