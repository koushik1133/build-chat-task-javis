import { query, queryOne } from "@/lib/dsql";
import { tableExists } from "@/lib/table-exists";
import { parseOrgSettings } from "@/lib/org-settings";
import { deriveChecklist, EMPTY_FACTS, type Checklist, type ChecklistFacts } from "./checklist";

/**
 * Onboarding state for a workspace: the raw settings flags plus the derived
 * "Finish setup" checklist. Every query is guarded so a missing table just
 * leaves that item undone.
 */

export interface OnboardingStatus {
  completedAt: string | null;
  checklistDismissed: boolean;
  industry: string | null;
  modules: Record<string, unknown> | null;
  checklist: Checklist;
}

type CountRow = { n: string | number | null };
const count = async (sql: string, params: unknown[]): Promise<number> => {
  const r = await queryOne<CountRow>(sql, params).catch(() => null);
  return Number(r?.n ?? 0);
};

export async function readOrgSettingsRaw(dataId: string): Promise<Record<string, unknown>> {
  const row = await queryOne<{ settings: string | null }>(`SELECT settings FROM organizations WHERE owner_user_id = $1`, [dataId]).catch(() => null);
  return parseOrgSettings(row?.settings);
}

/** Merge keys into organizations.settings (other keys untouched). */
export async function mergeOrgSettings(dataId: string, patch: Record<string, unknown>): Promise<Record<string, unknown>> {
  const current = await readOrgSettingsRaw(dataId);
  const next = { ...current, ...patch };
  await query(`UPDATE organizations SET settings = $2, updated_at = NOW() WHERE owner_user_id = $1`, [dataId, JSON.stringify(next)]);
  return next;
}

export async function loadChecklistFacts(dataId: string, orgId: string | null): Promise<ChecklistFacts> {
  const settings = await readOrgSettingsRaw(dataId);
  const profileRow = await queryOne<{ completed: boolean | null }>(`SELECT completed FROM business_profile WHERE user_id = $1`, [dataId]).catch(() => null);
  const [packs, contacts, quotes, bookingTypes, members, social, mail, integ, budget] = await Promise.all([
    (await tableExists("record_types")) ? count(`SELECT COUNT(*) AS n FROM record_types WHERE user_id = $1`, [dataId]) : 0,
    count(`SELECT COUNT(*) AS n FROM crm_contacts WHERE user_id = $1`, [dataId]),
    count(`SELECT COUNT(*) AS n FROM quotes WHERE user_id = $1`, [dataId]),
    count(`SELECT COUNT(*) AS n FROM booking_types WHERE user_id = $1 AND active = TRUE`, [dataId]),
    orgId ? count(`SELECT COUNT(*) AS n FROM memberships WHERE org_id = $1 AND role <> 'owner' AND status IN ('active', 'invited')`, [orgId]) : 0,
    count(`SELECT COUNT(*) AS n FROM social_accounts WHERE user_id = $1`, [dataId]),
    (await tableExists("mail_accounts")) ? count(`SELECT COUNT(*) AS n FROM mail_accounts WHERE user_id = $1`, [dataId]) : 0,
    count(`SELECT COUNT(*) AS n FROM user_integrations WHERE user_id = $1 AND (slack_connected_at IS NOT NULL OR email_connected_at IS NOT NULL)`, [dataId]),
    count(`SELECT COUNT(*) AS n FROM ai_budgets WHERE user_id = $1 AND monthly_cap_micros IS NOT NULL`, [dataId]),
  ]);
  return {
    ...EMPTY_FACTS,
    profileCompleted: Boolean(profileRow?.completed) || typeof settings.onboarding_completed_at === "string",
    packsInstalled: packs,
    contacts,
    quotes,
    activeBookingTypes: bookingTypes,
    teamMembers: members,
    channelsConnected: social + mail + integ,
    aiBudgetSet: budget > 0,
  };
}

export async function getOnboardingStatus(dataId: string, orgId: string | null): Promise<OnboardingStatus> {
  const settings = await readOrgSettingsRaw(dataId);
  const facts = await loadChecklistFacts(dataId, orgId);
  const mods = settings.modules;
  return {
    completedAt: typeof settings.onboarding_completed_at === "string" ? settings.onboarding_completed_at : null,
    checklistDismissed: settings.onboarding_checklist_dismissed === true,
    industry: typeof settings.industry === "string" ? settings.industry : null,
    modules: mods && typeof mods === "object" && !Array.isArray(mods) ? (mods as Record<string, unknown>) : null,
    checklist: deriveChecklist(facts),
  };
}
