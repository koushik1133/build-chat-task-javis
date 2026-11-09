import { randomUUID } from "crypto";
import { z } from "zod";
import { query, queryOne } from "@/lib/dsql";
import { tableExists } from "@/lib/table-exists";
import { getOrgSettings } from "@/lib/org-settings";
import { inQuietHours, quietHoursEnd } from "@/lib/reports/schedule";

/**
 * Per-member notification preferences: a category × channel matrix, digest
 * cadence and quiet hours. `notificationAllowed()` is the gate outbox
 * enqueuers consult when a notification carries `data.category` and
 * `data.member_user_id`.
 */

export const NOTIFICATION_CATEGORIES = ["approvals", "helpdesk", "billing", "bookings", "agents", "team", "reports", "system"] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];
export const PREF_CHANNELS = ["in_app", "email", "push", "sms"] as const;
export type PrefChannel = (typeof PREF_CHANNELS)[number];
export type DigestCadence = "daily" | "weekly" | "off";

export const CATEGORY_LABELS: Record<NotificationCategory, string> = {
  approvals: "Approvals",
  helpdesk: "Helpdesk & SLA",
  billing: "Quotes, invoices & payments",
  bookings: "Bookings",
  agents: "Agent runs",
  team: "Team",
  reports: "Scheduled reports",
  system: "System",
};

export type ChannelMatrix = Record<NotificationCategory, Record<PrefChannel, boolean>>;

export interface QuietHours { start: string | null; end: string | null }

export interface NotificationPreferences {
  member_user_id: string;
  email: string | null;
  channels: ChannelMatrix;
  digest: DigestCadence;
  digest_hour: number;
  digest_weekday: number | null;
  quiet_hours: QuietHours | null;
  updated_at: string | null;
}

/** Defaults: everything on except SMS, which is opt-in. */
export function defaultMatrix(): ChannelMatrix {
  return Object.fromEntries(NOTIFICATION_CATEGORIES.map((c) => [c, { in_app: true, email: true, push: true, sms: false }])) as ChannelMatrix;
}

export function isNotificationCategory(v: unknown): v is NotificationCategory {
  return typeof v === "string" && (NOTIFICATION_CATEGORIES as readonly string[]).includes(v);
}

const HHMM = z.string().regex(/^([01]?\d|2[0-3]):[0-5]\d$/, "HH:MM");
export const PreferencesPatchSchema = z
  .object({
    channels: z.record(z.enum(NOTIFICATION_CATEGORIES), z.object({ in_app: z.boolean().optional(), email: z.boolean().optional(), push: z.boolean().optional(), sms: z.boolean().optional() }).strict()).optional(),
    digest: z.enum(["daily", "weekly", "off"]).optional(),
    digest_hour: z.number().int().min(0).max(23).optional(),
    digest_weekday: z.number().int().min(0).max(6).optional().nullable(),
    quiet_hours: z.object({ start: HHMM.nullable(), end: HHMM.nullable() }).strict().optional().nullable(),
  })
  .strict();
export type PreferencesPatch = z.infer<typeof PreferencesPatchSchema>;

interface PrefRow {
  id: string;
  user_id: string;
  member_user_id: string;
  email: string | null;
  channel_prefs: string;
  digest: string;
  digest_hour: number;
  digest_weekday: number | null;
  quiet_hours: string | null;
  last_digest_at: string | null;
  updated_at: string;
}

/** Pure merge of stored JSON (partial) onto the defaults. */
export function parseMatrix(raw: string | null | undefined): ChannelMatrix {
  const out = defaultMatrix();
  if (!raw) return out;
  try {
    const v = JSON.parse(raw) as Record<string, Record<string, unknown>>;
    for (const c of NOTIFICATION_CATEGORIES) {
      const row = v?.[c];
      if (!row || typeof row !== "object") continue;
      for (const ch of PREF_CHANNELS) if (typeof row[ch] === "boolean") out[c][ch] = row[ch] as boolean;
    }
  } catch {
    /* defaults */
  }
  return out;
}

function parseQuiet(raw: string | null): QuietHours | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as { start?: unknown; end?: unknown };
    const start = typeof v.start === "string" ? v.start : null;
    const end = typeof v.end === "string" ? v.end : null;
    return start || end ? { start, end } : null;
  } catch {
    return null;
  }
}

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));

function toPrefs(row: PrefRow | null, memberUserId: string): NotificationPreferences {
  if (!row) return { member_user_id: memberUserId, email: null, channels: defaultMatrix(), digest: "off", digest_hour: 8, digest_weekday: 1, quiet_hours: null, updated_at: null };
  return {
    member_user_id: row.member_user_id,
    email: row.email,
    channels: parseMatrix(row.channel_prefs),
    digest: row.digest === "daily" || row.digest === "weekly" ? row.digest : "off",
    digest_hour: Number(row.digest_hour ?? 8),
    digest_weekday: row.digest_weekday === null ? null : Number(row.digest_weekday),
    quiet_hours: parseQuiet(row.quiet_hours),
    updated_at: iso(row.updated_at),
  };
}

export async function getPreferences(dataId: string, memberUserId: string): Promise<NotificationPreferences> {
  if (!(await tableExists("notification_preferences"))) return toPrefs(null, memberUserId);
  const row = await queryOne<PrefRow>(`SELECT * FROM notification_preferences WHERE user_id = $1 AND member_user_id = $2`, [dataId, memberUserId]).catch(() => null);
  return toPrefs(row, memberUserId);
}

/** Apply a patch onto the member's prefs (pure). */
export function applyPatch(cur: NotificationPreferences, patch: PreferencesPatch): NotificationPreferences {
  const channels = { ...cur.channels };
  for (const c of NOTIFICATION_CATEGORIES) {
    const p = patch.channels?.[c];
    if (p) channels[c] = { ...channels[c], ...Object.fromEntries(Object.entries(p).filter(([, v]) => typeof v === "boolean")) };
  }
  return {
    ...cur,
    channels,
    digest: patch.digest ?? cur.digest,
    digest_hour: patch.digest_hour ?? cur.digest_hour,
    digest_weekday: patch.digest_weekday === undefined ? cur.digest_weekday : patch.digest_weekday,
    quiet_hours: patch.quiet_hours === undefined ? cur.quiet_hours : patch.quiet_hours,
  };
}

export async function updatePreferences(dataId: string, memberUserId: string, patch: PreferencesPatch, email: string | null): Promise<NotificationPreferences> {
  const cur = await getPreferences(dataId, memberUserId);
  const next = applyPatch(cur, patch);
  const existing = await queryOne<{ id: string }>(`SELECT id FROM notification_preferences WHERE user_id = $1 AND member_user_id = $2`, [dataId, memberUserId]);
  const values = [JSON.stringify(next.channels), next.digest, next.digest_hour, next.digest_weekday, next.quiet_hours ? JSON.stringify(next.quiet_hours) : null, email ?? cur.email];
  if (existing) {
    await query(`UPDATE notification_preferences SET channel_prefs = $3, digest = $4, digest_hour = $5, digest_weekday = $6, quiet_hours = $7, email = COALESCE($8, email), updated_at = NOW() WHERE user_id = $1 AND member_user_id = $2`, [dataId, memberUserId, ...values]);
  } else {
    await query(
      `INSERT INTO notification_preferences (id, user_id, member_user_id, channel_prefs, digest, digest_hour, digest_weekday, quiet_hours, email, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())`,
      [randomUUID(), dataId, memberUserId, ...values]
    );
  }
  return getPreferences(dataId, memberUserId);
}

export interface AllowedDecision {
  allowed: boolean;
  /** When quiet hours apply to a push/sms, deliver at this instant instead of dropping. */
  deferUntil: Date | null;
  reason: "ok" | "channel_off" | "quiet_hours";
}

/** Pure gate (exported for tests). Quiet hours defer push/SMS; in-app and email are never deferred. */
export function decideAllowed(prefs: NotificationPreferences, category: NotificationCategory, channel: PrefChannel, now: Date, timeZone: string): AllowedDecision {
  if (!prefs.channels[category]?.[channel]) return { allowed: false, deferUntil: null, reason: "channel_off" };
  if ((channel === "push" || channel === "sms") && prefs.quiet_hours && inQuietHours(prefs.quiet_hours, now, timeZone)) {
    return { allowed: true, deferUntil: quietHoursEnd(prefs.quiet_hours, now, timeZone), reason: "quiet_hours" };
  }
  return { allowed: true, deferUntil: null, reason: "ok" };
}

/**
 * Whether a member wants `category` on `channel` right now. Unknown
 * categories/channels and lookup failures default to allowed so a prefs
 * outage never silences notifications.
 */
export async function notificationAllowed(dataId: string, memberUserId: string, category: string, channel: string, now = new Date()): Promise<AllowedDecision> {
  if (!isNotificationCategory(category) || !(PREF_CHANNELS as readonly string[]).includes(channel)) return { allowed: true, deferUntil: null, reason: "ok" };
  try {
    const [prefs, settings] = await Promise.all([getPreferences(dataId, memberUserId), getOrgSettings(dataId).catch(() => null)]);
    return decideAllowed(prefs, category, channel as PrefChannel, now, settings?.timezone ?? "UTC");
  } catch {
    return { allowed: true, deferUntil: null, reason: "ok" };
  }
}

/** Members (of one org) with a digest turned on. */
export interface DigestMember { member_user_id: string; email: string | null; prefs: NotificationPreferences; last_digest_at: string | null }

export async function listDigestMembers(dataId: string): Promise<DigestMember[]> {
  if (!(await tableExists("notification_preferences"))) return [];
  const rows = await query<PrefRow>(`SELECT * FROM notification_preferences WHERE user_id = $1 AND digest IN ('daily', 'weekly')`, [dataId]);
  return rows.map((r) => ({ member_user_id: r.member_user_id, email: r.email, prefs: toPrefs(r, r.member_user_id), last_digest_at: r.last_digest_at ? iso(r.last_digest_at) : null }));
}

/** Every org data id that has at least one digest subscriber. */
export async function listDigestOrgs(limit = 200): Promise<string[]> {
  if (!(await tableExists("notification_preferences"))) return [];
  const rows = await query<{ user_id: string }>(`SELECT DISTINCT user_id FROM notification_preferences WHERE digest IN ('daily', 'weekly') LIMIT $1`, [Math.max(1, Math.min(1000, limit))]);
  return rows.map((r) => r.user_id);
}

export async function markDigestSent(dataId: string, memberUserId: string, at = new Date()): Promise<void> {
  await query(`UPDATE notification_preferences SET last_digest_at = $3 WHERE user_id = $1 AND member_user_id = $2`, [dataId, memberUserId, at.toISOString()]);
}
