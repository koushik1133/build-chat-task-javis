import { query, queryOne } from "@/lib/dsql";
import { parseOrgSettings } from "@/lib/org-settings";
import { DEFAULT_PRIVACY_SETTINGS, toPrivacySettings, type PrivacySettings } from "./constants";

/**
 * Privacy settings live under `organizations.settings.privacy` (JSON TEXT) so
 * no org migration is needed. Other keys in the JSON are preserved on write.
 */

export async function getPrivacySettings(dataId: string): Promise<PrivacySettings> {
  const row = await queryOne<{ settings: string | null }>(`SELECT settings FROM organizations WHERE owner_user_id = $1`, [dataId]).catch(() => null);
  if (!row) return DEFAULT_PRIVACY_SETTINGS;
  return toPrivacySettings(parseOrgSettings(row.settings).privacy);
}

export async function updatePrivacySettings(dataId: string, patch: Partial<PrivacySettings>): Promise<PrivacySettings> {
  const row = await queryOne<{ settings: string | null }>(`SELECT settings FROM organizations WHERE owner_user_id = $1`, [dataId]);
  const current = parseOrgSettings(row?.settings);
  const next = toPrivacySettings({ ...toPrivacySettings(current.privacy), ...patch });
  await query(`UPDATE organizations SET settings = $2, updated_at = NOW() WHERE owner_user_id = $1`, [dataId, JSON.stringify({ ...current, privacy: next })]);
  return next;
}
