/**
 * Client-safe marketing constants and shapes (no DB imports). The pages, the
 * route schemas and the server libs all read from here.
 */
import { z } from "zod";
import type { ConsentPurpose } from "@/lib/privacy/constants";

export const MARKETING_CHANNELS = ["email", "sms"] as const;
export type MarketingSendChannel = (typeof MARKETING_CHANNELS)[number];

export const CAMPAIGN_STATUSES = ["draft", "scheduled", "sending", "sent", "paused", "cancelled"] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

export const RECIPIENT_STATUSES = ["queued", "skipped_no_consent", "sent", "delivered", "bounced", "failed", "unsubscribed"] as const;
export type RecipientStatus = (typeof RECIPIENT_STATUSES)[number];

export const SEQUENCE_TRIGGERS = ["manual", "audience_join", "event"] as const;
export type SequenceTrigger = (typeof SEQUENCE_TRIGGERS)[number];

export const SEQUENCE_STATUSES = ["active", "paused"] as const;
export type SequenceStatus = (typeof SEQUENCE_STATUSES)[number];

export const ENROLLMENT_STATUSES = ["active", "done", "exited"] as const;
export type EnrollmentStatus = (typeof ENROLLMENT_STATUSES)[number];

export const TEMPLATE_CATEGORIES = ["general", "newsletter", "promotion", "onboarding", "announcement", "sms"] as const;

export const LIFECYCLES = ["lead", "prospect", "customer", "churned", "donor", "patient", "student"] as const;

/** Merge fields available in subjects and bodies. */
export const MERGE_FIELDS = [
  { key: "first_name", label: "First name" },
  { key: "full_name", label: "Full name" },
  { key: "company", label: "Company" },
  { key: "email", label: "Email" },
  { key: "org_name", label: "Your business name" },
  { key: "unsubscribe_url", label: "Unsubscribe link (required in email)" },
] as const;

/* ---------- audience definition ---------- */

export const AudienceDefinitionSchema = z
  .object({
    lifecycle: z.array(z.enum(LIFECYCLES)).max(10).optional(),
    tags: z.array(z.string().trim().min(1).max(60)).max(20).optional(),
    q: z.string().trim().max(120).optional(),
    consent_purpose: z.enum(["marketing_email", "marketing_sms", "marketing_voice"]).optional(),
    has_email: z.boolean().optional(),
    has_phone: z.boolean().optional(),
    last_activity_days: z.number().int().min(1).max(3650).optional(),
    record_type: z.string().trim().max(80).optional(),
    stage: z.string().trim().max(80).optional(),
  })
  .strict();
export type AudienceDefinition = z.infer<typeof AudienceDefinitionSchema>;

export function parseAudienceDefinition(raw: string | null | undefined): AudienceDefinition {
  if (!raw) return {};
  try {
    const parsed = AudienceDefinitionSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

/** Human summary of a definition for list rows. */
export function describeAudience(def: AudienceDefinition): string {
  const parts: string[] = [];
  if (def.lifecycle?.length) parts.push(`lifecycle: ${def.lifecycle.join(", ")}`);
  if (def.tags?.length) parts.push(`tags: ${def.tags.join(", ")}`);
  if (def.q) parts.push(`matches "${def.q}"`);
  if (def.has_email) parts.push("has email");
  if (def.has_phone) parts.push("has phone");
  if (def.last_activity_days) parts.push(`active in last ${def.last_activity_days}d`);
  if (def.consent_purpose) parts.push(`consented: ${def.consent_purpose.replace("marketing_", "")}`);
  if (def.record_type) parts.push(`record ${def.record_type}${def.stage ? ` @ ${def.stage}` : ""}`);
  return parts.length ? parts.join(" · ") : "All contacts";
}

/* ---------- sequences ---------- */

export const SequenceStepSchema = z
  .object({
    delay_hours: z.number().min(0).max(24 * 365),
    channel: z.enum(MARKETING_CHANNELS),
    template_id: z.string().max(80).nullable().optional(),
    subject: z.string().max(300).nullable().optional(),
    body_md: z.string().max(50_000).nullable().optional(),
  })
  .strict();
export type SequenceStep = z.infer<typeof SequenceStepSchema>;

export const SequenceTriggerConfigSchema = z
  .object({
    audience_id: z.string().max(80).nullable().optional(),
    event_type: z.string().max(80).nullable().optional(),
  })
  .strict();
export type SequenceTriggerConfig = z.infer<typeof SequenceTriggerConfigSchema>;

export function parseSteps(raw: string | null | undefined): SequenceStep[] {
  if (!raw) return [];
  try {
    const v = z.array(SequenceStepSchema).safeParse(JSON.parse(raw));
    return v.success ? v.data : [];
  } catch {
    return [];
  }
}

export function parseTriggerConfig(raw: string | null | undefined): SequenceTriggerConfig {
  if (!raw) return {};
  try {
    const v = SequenceTriggerConfigSchema.safeParse(JSON.parse(raw));
    return v.success ? v.data : {};
  } catch {
    return {};
  }
}

/* ---------- stats ---------- */

export interface CampaignStats {
  total: number;
  queued: number;
  skipped_no_consent: number;
  sent: number;
  delivered: number;
  opened: number;
  clicked: number;
  bounced: number;
  failed: number;
  unsubscribed: number;
  /** Percentages (0-100) against delivered (open/click) or sent (bounce/unsub). */
  open_rate: number;
  click_rate: number;
  bounce_rate: number;
  unsubscribe_rate: number;
}

export function emptyCampaignStats(): CampaignStats {
  return { total: 0, queued: 0, skipped_no_consent: 0, sent: 0, delivered: 0, opened: 0, clicked: 0, bounced: 0, failed: 0, unsubscribed: 0, open_rate: 0, click_rate: 0, bounce_rate: 0, unsubscribe_rate: 0 };
}

const pct = (num: number, den: number) => (den > 0 ? Math.round((num / den) * 1000) / 10 : 0);

/**
 * Pure stats math. `byStatus` counts recipients per current status; opened /
 * clicked are counted from timestamps because a recipient keeps its delivery
 * status when it opens. "Sent" in the funnel includes everything past queued
 * that was actually handed to a channel (sent + delivered + bounced + unsubscribed).
 */
export function computeCampaignStats(byStatus: Partial<Record<RecipientStatus, number>>, opened: number, clicked: number): CampaignStats {
  const s = emptyCampaignStats();
  for (const k of RECIPIENT_STATUSES) s[k] = byStatus[k] ?? 0;
  s.total = RECIPIENT_STATUSES.reduce((n, k) => n + (byStatus[k] ?? 0), 0);
  s.opened = opened;
  s.clicked = clicked;
  const handed = s.sent + s.delivered + s.bounced + s.unsubscribed;
  const deliveredOrBetter = s.delivered + s.unsubscribed;
  s.open_rate = pct(s.opened, deliveredOrBetter || handed);
  s.click_rate = pct(s.clicked, deliveredOrBetter || handed);
  s.bounce_rate = pct(s.bounced, handed);
  s.unsubscribe_rate = pct(s.unsubscribed, handed);
  return s;
}

export const CONSENT_PURPOSE_FOR_CHANNEL: Record<MarketingSendChannel, ConsentPurpose> = { email: "marketing_email", sms: "marketing_sms" };
