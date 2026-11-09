/**
 * Client-safe privacy constants and pure date math. No DB imports here so
 * "use client" pages may import this module.
 */

export const CONSENT_PURPOSES = ["marketing_email", "marketing_sms", "marketing_voice", "transactional", "analytics", "portal"] as const;
export type ConsentPurpose = (typeof CONSENT_PURPOSES)[number];

export const CONSENT_PURPOSE_LABELS: Record<ConsentPurpose, string> = {
  marketing_email: "Marketing emails",
  marketing_sms: "Marketing SMS / WhatsApp",
  marketing_voice: "Marketing phone calls",
  transactional: "Service messages (bookings, invoices, support)",
  analytics: "Usage analytics",
  portal: "Client portal access",
};

/** Purposes a subject may toggle themselves. `transactional` runs on a service ground, not consent. */
export const SELF_SERVICE_PURPOSES: readonly ConsentPurpose[] = ["marketing_email", "marketing_sms", "marketing_voice", "analytics"];

export const CONSENT_SUBJECT_KINDS = ["contact", "lead", "member", "tombstone"] as const;
export type ConsentSubjectKind = (typeof CONSENT_SUBJECT_KINDS)[number];

export const CONSENT_SOURCES = ["form", "portal", "import", "manual", "api"] as const;
export type ConsentSource = (typeof CONSENT_SOURCES)[number];

export type ConsentStatus = "granted" | "withdrawn";

export type MarketingChannel = "email" | "sms" | "voice";
export const CHANNEL_PURPOSE: Record<MarketingChannel, ConsentPurpose> = {
  email: "marketing_email",
  sms: "marketing_sms",
  voice: "marketing_voice",
};

export const DSR_KINDS = ["access", "erasure", "correction", "portability", "nomination"] as const;
export type DsrKind = (typeof DSR_KINDS)[number];

export const DSR_STATUSES = ["received", "verifying", "in_progress", "completed", "rejected"] as const;
export type DsrStatus = (typeof DSR_STATUSES)[number];

export const DSR_SUBJECT_KINDS = ["contact", "lead"] as const;
export type DsrSubjectKind = (typeof DSR_SUBJECT_KINDS)[number];

export function isDsrKind(v: unknown): v is DsrKind {
  return typeof v === "string" && (DSR_KINDS as readonly string[]).includes(v);
}
export function isConsentPurpose(v: unknown): v is ConsentPurpose {
  return typeof v === "string" && (CONSENT_PURPOSES as readonly string[]).includes(v);
}

/** Default statutory response window. DPDP Rules cap the published period at 90 days. */
export const DEFAULT_DSR_DUE_DAYS = 30;
export const MAX_DSR_DUE_DAYS = 90;
export const DSR_REMINDER_DAYS = 5;

export function clampDueDays(days: number | null | undefined): number {
  if (!Number.isFinite(days as number) || !days || days < 1) return DEFAULT_DSR_DUE_DAYS;
  return Math.min(MAX_DSR_DUE_DAYS, Math.floor(days));
}

/** due_at = requested_at + N days (N clamped to 1..90). */
export function computeDueAt(requestedAt: Date, dueDays?: number | null): Date {
  return new Date(requestedAt.getTime() + clampDueDays(dueDays) * 86_400_000);
}

/** Whole days left (negative when overdue). */
export function daysUntil(dueAt: Date | string, now: Date = new Date()): number {
  const due = typeof dueAt === "string" ? new Date(dueAt) : dueAt;
  return Math.ceil((due.getTime() - now.getTime()) / 86_400_000);
}

export function isDueSoon(dueAt: Date | string, now: Date = new Date(), withinDays = DSR_REMINDER_DAYS): boolean {
  return daysUntil(dueAt, now) <= withinDays;
}

/** Breach notification: detailed update to the authority is due 72h after detection. */
export const BREACH_NOTIFY_HOURS = 72;

export function breachDeadline(detectedAt: Date | string): Date {
  const d = typeof detectedAt === "string" ? new Date(detectedAt) : detectedAt;
  return new Date(d.getTime() + BREACH_NOTIFY_HOURS * 3_600_000);
}

/** Hours remaining on the 72h clock (negative = overdue). */
export function breachHoursRemaining(detectedAt: Date | string, now: Date = new Date()): number {
  return (breachDeadline(detectedAt).getTime() - now.getTime()) / 3_600_000;
}

export const INCIDENT_SEVERITIES = ["low", "medium", "high", "critical"] as const;
export type IncidentSeverity = (typeof INCIDENT_SEVERITIES)[number];
export const INCIDENT_STATUSES = ["open", "contained", "notified", "closed"] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];

/* ---------- retention ---------- */

export const RETENTION_KINDS = ["tickets_closed", "mail_bodies", "leads_resolved", "voice_recordings", "outbox", "audit_log"] as const;
export type RetentionKind = (typeof RETENTION_KINDS)[number];

export const RETENTION_ACTIONS = ["anonymize", "delete", "archive"] as const;
export type RetentionAction = (typeof RETENTION_ACTIONS)[number];

export interface RetentionKindMeta {
  label: string;
  description: string;
  /** Minimum keep_days the org may configure (statutory floor). */
  minDays: number;
  defaultDays: number;
  actions: readonly RetentionAction[];
}

export const RETENTION_META: Record<RetentionKind, RetentionKindMeta> = {
  tickets_closed: { label: "Closed support tickets", description: "Tickets resolved or closed longer ago than this.", minDays: 30, defaultDays: 730, actions: ["anonymize", "delete"] },
  mail_bodies: { label: "Email message bodies", description: "Synced mailbox bodies; headers stay for threading.", minDays: 30, defaultDays: 365, actions: ["anonymize", "delete"] },
  leads_resolved: { label: "Converted / lost leads", description: "Leads no longer in the 'new' or 'contacted' state.", minDays: 30, defaultDays: 365, actions: ["anonymize", "delete"] },
  voice_recordings: { label: "Call recordings & transcripts", description: "Voice campaign recording URLs and transcripts.", minDays: 7, defaultDays: 90, actions: ["anonymize"] },
  outbox: { label: "Notification outbox", description: "Sent / simulated / failed outbound notification rows.", minDays: 7, defaultDays: 90, actions: ["delete"] },
  audit_log: { label: "Audit log", description: "Who changed what. Statutory floor of one year.", minDays: 365, defaultDays: 1095, actions: ["archive", "delete"] },
};

/** Entities that are never purged by retention (accounting records). */
export const RETENTION_NEVER = ["invoices", "invoice_payments", "quotes"] as const;

/** Clamp a requested keep_days to the kind's floor. Pure; unit-tested. */
export function enforceRetentionFloor(kind: RetentionKind, keepDays: number): number {
  const min = RETENTION_META[kind].minDays;
  if (!Number.isFinite(keepDays) || keepDays < min) return min;
  return Math.floor(keepDays);
}

export function isRetentionKind(v: unknown): v is RetentionKind {
  return typeof v === "string" && (RETENTION_KINDS as readonly string[]).includes(v);
}
export function isRetentionAction(v: unknown): v is RetentionAction {
  return typeof v === "string" && (RETENTION_ACTIONS as readonly string[]).includes(v);
}

/* ---------- org privacy settings (stored in organizations.settings JSON under "privacy") ---------- */

export interface PrivacySettings {
  grievance_officer_name: string | null;
  grievance_officer_email: string | null;
  dsr_due_days: number;
  auto_fulfil_access: boolean;
}

export const DEFAULT_PRIVACY_SETTINGS: PrivacySettings = {
  grievance_officer_name: null,
  grievance_officer_email: null,
  dsr_due_days: DEFAULT_DSR_DUE_DAYS,
  auto_fulfil_access: false,
};

export function toPrivacySettings(raw: unknown): PrivacySettings {
  const r = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return {
    grievance_officer_name: typeof r.grievance_officer_name === "string" && r.grievance_officer_name.trim() ? r.grievance_officer_name.trim().slice(0, 200) : null,
    grievance_officer_email: typeof r.grievance_officer_email === "string" && r.grievance_officer_email.trim() ? r.grievance_officer_email.trim().slice(0, 320) : null,
    dsr_due_days: clampDueDays(typeof r.dsr_due_days === "number" ? r.dsr_due_days : null),
    auto_fulfil_access: r.auto_fulfil_access === true,
  };
}
