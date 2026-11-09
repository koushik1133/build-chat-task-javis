import { z } from "zod";
import { findForbiddenKeys, findSecretPaths, MAX_ITEMS_PER_SECTION, MAX_SNAPSHOT_BYTES, SECTION_KEYS, SNAPSHOT_SCHEMA_VERSION, type SectionKey } from "./types";

/**
 * Zod schema for the snapshot document (`schema: 1`). Client-safe.
 * Every item schema is `.strict()`: unknown keys (including anything that
 * smells like a credential) are validation errors, not silently kept.
 */

const short = (n: number) => z.string().trim().min(1).max(n);
const opt = (n: number) => z.string().max(n).nullable().optional();
const json = z.unknown();
const arr = <T extends z.ZodTypeAny>(s: T) => z.array(s).max(MAX_ITEMS_PER_SECTION).optional();

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const httpsUrl = z
  .string()
  .max(2000)
  .refine((v) => {
    try {
      const u = new URL(v);
      return u.protocol === "https:" && !u.username && !u.password;
    } catch {
      return false;
    }
  }, "must be an https URL");

export const SettingsSectionSchema = z
  .object({
    locale: z.string().max(10).optional(),
    currency: z.string().length(3).optional(),
    timezone: z.string().max(64).optional(),
    billing: z
      .object({
        tax_id_label: z.string().max(40).optional(),
        prices_include_tax: z.boolean().optional(),
        tax_rounding: z.enum(["per_line", "per_total"]).optional(),
        default_terms_days: z.number().int().min(0).max(365).optional(),
        dunning_schedule: z.array(z.number().int().min(-60).max(365)).max(12).optional(),
        quote_prefix: z.string().max(10).optional(),
        invoice_prefix: z.string().max(10).optional(),
        credit_note_prefix: z.string().max(10).optional(),
        reporting_currency: z.string().length(3).nullable().optional(),
      })
      .strict()
      .optional(),
    privacy: z.object({ dsr_due_days: z.number().int().min(1).max(365).optional(), auto_fulfil_access: z.boolean().optional() }).strict().optional(),
  })
  .strict();

export const BrandingSectionSchema = z
  .object({
    brand_name: opt(120),
    primary_color: hex.nullable().optional(),
    accent_color: hex.nullable().optional(),
    email_footer: opt(2000),
    /** Only https URLs survive a round trip. */
    logo_url: httpsUrl.nullable().optional(),
  })
  .strict();

export const StorefrontSectionSchema = z
  .object({
    title: opt(120),
    intro_md: opt(20_000),
    currency: z.string().length(3).optional(),
    collect_shipping: z.boolean().optional(),
    shipping_flat_minor: z.number().int().min(0).max(1_000_000_000).optional(),
    pickup_enabled: z.boolean().optional(),
    terms_md: opt(40_000),
    settings: z.object({ max_qty_per_line: z.number().int().min(1).max(1000).optional(), cart_ttl_hours: z.number().int().min(1).max(720).optional() }).strict().optional(),
  })
  .strict();

const RecordTypeItem = z
  .object({
    slug: short(80),
    name: short(120),
    icon: opt(60),
    description: opt(2000),
    fields: z.array(json).max(100),
    stages: z.array(json).max(50),
    views: z.record(json).default({}),
    copilot_prompt: opt(4000),
    pack_slug: opt(80),
  })
  .strict();

const TaxRateItem = z
  .object({
    name: short(80),
    rate_bp: z.number().int().min(0).max(10_000),
    kind: z.string().max(20).default("other"),
    jurisdiction: opt(80),
    compound: z.boolean().optional(),
    is_default: z.boolean().optional(),
    active: z.boolean().optional(),
  })
  .strict();

const SlaItem = z
  .object({
    name: short(120),
    first_response_minutes: z.number().int().min(1).max(525_600),
    resolution_minutes: z.number().int().min(1).max(525_600),
    business_hours_only: z.boolean().optional(),
    priority_overrides: z.record(json).nullable().optional(),
    is_default: z.boolean().optional(),
  })
  .strict();

/** Scrubbed v2 automation definition (see marketplace scrubAutomationV2). */
const AutomationItem = z
  .object({
    schema: z.literal(2),
    name: short(120),
    description: opt(1000),
    trigger_type: z.string().max(20),
    trigger_config: z.record(json).default({}),
    conditions: json.nullable().optional(),
    steps: z.array(json).max(50),
    autonomy: z.enum(["approve", "auto"]),
  })
  .strict();

const AgentItem = z
  .object({
    name: short(120),
    role: short(120),
    system_prompt: opt(20_000),
    tools: z.array(z.string().max(120)).max(200).nullable().optional(),
    autonomy_level: z.enum(["draft", "approve", "auto"]).default("approve"),
    model: opt(120),
    max_steps: z.number().int().min(1).max(200).nullable().optional(),
  })
  .strict();

const PlaybookItem = z.object({ playbook_id: short(80), enabled: z.boolean() }).strict();

const KbItem = z
  .object({
    slug: short(160),
    title: short(200),
    body_md: z.string().max(200_000),
    excerpt: opt(500),
    category: opt(100),
    tags: z.array(z.string().max(60)).max(30).default([]),
    is_public: z.boolean().optional(),
  })
  .strict();

const DocTemplateItem = z
  .object({
    name: short(200),
    kind: z.string().max(20).default("other"),
    body_md: z.string().max(200_000),
    fields: z.array(json).max(100).default([]),
    requires_signature: z.boolean().optional(),
    signer_roles: z.array(z.string().max(60)).max(10).default([]),
  })
  .strict();

const EmailTemplateItem = z
  .object({
    name: short(120),
    subject: z.string().max(300).default(""),
    preheader: opt(300),
    body_md: z.string().max(200_000),
    category: z.string().max(40).nullable().optional(),
  })
  .strict();

const SequenceItem = z
  .object({
    name: short(120),
    trigger: z.string().max(30),
    /** Audience referenced by NAME (ids are workspace specific). */
    trigger_config: z.object({ audience_name: z.string().max(120).optional(), event_type: z.string().max(120).optional() }).strict().default({}),
    steps: z.array(z.record(json)).min(1).max(20),
    status: z.enum(["active", "paused"]).optional(),
  })
  .strict();

const AudienceItem = z.object({ name: short(120), definition: z.record(json).default({}), is_dynamic: z.boolean().optional() }).strict();

const SavedReportItem = z
  .object({ name: short(120), description: opt(1000), spec: json, chart: json.optional(), visibility: z.enum(["private", "org"]).optional() })
  .strict();

const DashboardItem = z
  .object({ name: short(120), role: z.string().max(20).nullable().optional(), layout: z.array(json).max(40).default([]), is_default: z.boolean().optional() })
  .strict();

const RetentionItem = z
  .object({ entity_kind: short(40), keep_days: z.number().int().min(1).max(36_500), action: z.enum(["anonymize", "delete", "archive"]), enabled: z.boolean() })
  .strict();

const PrivacyNoticeItem = z.object({ locale: short(10), body_md: z.string().min(1).max(200_000) }).strict();

export const SnapshotSectionsSchema = z
  .object({
    settings: SettingsSectionSchema.optional(),
    branding: BrandingSectionSchema.optional(),
    record_types: arr(RecordTypeItem),
    tax_rates: arr(TaxRateItem),
    sla_policies: arr(SlaItem),
    automations: arr(AutomationItem),
    agents: arr(AgentItem),
    playbook_settings: arr(PlaybookItem),
    kb_articles: arr(KbItem),
    document_templates: arr(DocTemplateItem),
    email_templates: arr(EmailTemplateItem),
    sequences: arr(SequenceItem),
    audiences: arr(AudienceItem),
    saved_reports: arr(SavedReportItem),
    dashboards: arr(DashboardItem),
    storefront: StorefrontSectionSchema.optional(),
    retention_policies: arr(RetentionItem),
    privacy_notices: arr(PrivacyNoticeItem),
  })
  .strict();

export const SnapshotSchema = z
  .object({
    schema: z.literal(SNAPSHOT_SCHEMA_VERSION),
    name: short(120),
    description: opt(1000),
    created_at: z.string().max(40).optional(),
    source: z.object({ product: z.string().max(40).optional() }).strict().optional(),
    sections: SnapshotSectionsSchema,
  })
  .strict();

export type SnapshotDoc = z.infer<typeof SnapshotSchema>;
export type SnapshotSections = z.infer<typeof SnapshotSectionsSchema>;

export function sectionsPresent(doc: Pick<SnapshotDoc, "sections">): SectionKey[] {
  return SECTION_KEYS.filter((k) => doc.sections[k] !== undefined);
}

export function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

export type ParseResult = { ok: true; snapshot: SnapshotDoc; bytes: number } | { ok: false; errors: string[] };

/** Parse + validate a snapshot from a JSON string or an already parsed value. Rejects secrets and oversize documents. */
export function parseSnapshot(input: unknown): ParseResult {
  let raw: unknown = input;
  let bytes = 0;
  if (typeof input === "string") {
    bytes = byteLength(input);
    if (bytes > MAX_SNAPSHOT_BYTES) return { ok: false, errors: [`Snapshot is larger than ${MAX_SNAPSHOT_BYTES / 1024 / 1024} MB`] };
    try {
      raw = JSON.parse(input);
    } catch {
      return { ok: false, errors: ["Not valid JSON"] };
    }
  } else {
    try {
      bytes = byteLength(JSON.stringify(input));
    } catch {
      return { ok: false, errors: ["Not serialisable"] };
    }
    if (bytes > MAX_SNAPSHOT_BYTES) return { ok: false, errors: [`Snapshot is larger than ${MAX_SNAPSHOT_BYTES / 1024 / 1024} MB`] };
  }
  const unsafe = findForbiddenKeys(raw);
  if (unsafe.length > 0) return { ok: false, errors: [`Snapshot contains reserved object keys and was rejected: ${unsafe.slice(0, 5).join(", ")}`] };
  // Secret scan first so a foreign file with a credential-like key gets a clear message.
  const secrets = findSecretPaths(raw);
  if (secrets.length > 0) return { ok: false, errors: [`Snapshot contains credential-like keys or values and was rejected: ${secrets.slice(0, 5).join(", ")}`] };
  const parsed = SnapshotSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.slice(0, 10).map((i) => `${i.path.join(".") || "$"}: ${i.message}`) };
  }
  return { ok: true, snapshot: parsed.data, bytes };
}
