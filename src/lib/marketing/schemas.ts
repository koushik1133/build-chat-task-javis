/** Zod request schemas for /api/marketing (client-safe). */
import { z } from "zod";
import { AudienceDefinitionSchema, CAMPAIGN_STATUSES, MARKETING_CHANNELS, RECIPIENT_STATUSES, SEQUENCE_STATUSES, SEQUENCE_TRIGGERS, SequenceStepSchema, SequenceTriggerConfigSchema, TEMPLATE_CATEGORIES } from "./types";

const isoDate = z.string().datetime({ offset: true });

export const AudienceCreateSchema = z.object({ name: z.string().trim().min(1).max(120), definition: AudienceDefinitionSchema.default({}), is_dynamic: z.boolean().optional() }).strict();
export const AudiencePatchSchema = AudienceCreateSchema.partial().strict();
export const AudiencePreviewSchema = z.object({ definition: AudienceDefinitionSchema, channel: z.enum(MARKETING_CHANNELS).optional(), limit: z.number().int().min(1).max(50).optional() }).strict();

export const TemplateCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    subject: z.string().max(300).optional(),
    preheader: z.string().max(300).nullable().optional(),
    body_md: z.string().min(1).max(50_000),
    category: z.enum(TEMPLATE_CATEGORIES).optional(),
  })
  .strict();
export const TemplatePatchSchema = TemplateCreateSchema.partial().strict();

export const CampaignCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    channel: z.enum(MARKETING_CHANNELS),
    audience_id: z.string().max(80).nullable().optional(),
    template_id: z.string().max(80).nullable().optional(),
    subject: z.string().max(300).nullable().optional(),
    preheader: z.string().max(300).nullable().optional(),
    body_md: z.string().max(50_000).nullable().optional(),
    from_name: z.string().max(120).nullable().optional(),
    reply_to: z.string().email().max(320).nullable().optional().or(z.literal("")),
    schedule_at: isoDate.nullable().optional(),
    /** Create and launch in one call. */
    launch: z.boolean().optional(),
  })
  .strict();
export const CampaignPatchSchema = CampaignCreateSchema.omit({ launch: true }).partial().strict();
export const CampaignListQuerySchema = z.object({ status: z.enum(CAMPAIGN_STATUSES).optional(), limit: z.coerce.number().int().min(1).max(200).optional(), cursor: z.string().max(512).optional() });
export const RecipientListQuerySchema = z.object({ status: z.enum(RECIPIENT_STATUSES).optional(), limit: z.coerce.number().int().min(1).max(200).optional(), cursor: z.string().max(512).optional() });
export const TestSendSchema = z.object({ email: z.string().email().max(320).optional(), phone: z.string().trim().min(6).max(40).optional() }).strict();
export const LaunchSchema = z.object({ force: z.boolean().optional() }).strict();

export const SequenceCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    trigger: z.enum(SEQUENCE_TRIGGERS).default("manual"),
    trigger_config: SequenceTriggerConfigSchema.nullable().optional(),
    steps: z.array(SequenceStepSchema).min(1).max(20),
    status: z.enum(SEQUENCE_STATUSES).optional(),
  })
  .strict();
export const SequencePatchSchema = SequenceCreateSchema.partial().strict();
export const EnrollSchema = z.object({ contact_ids: z.array(z.string().trim().min(1).max(80)).min(1).max(500) }).strict();

export const DraftSchema = z
  .object({
    goal: z.string().trim().min(3).max(2000),
    channel: z.enum(MARKETING_CHANNELS).default("email"),
    audience_id: z.string().max(80).nullable().optional(),
    tone: z.enum(["friendly", "professional", "playful", "urgent"]).optional(),
  })
  .strict();

export const PreviewSchema = z.object({ subject: z.string().max(300).optional(), preheader: z.string().max(300).nullable().optional(), body_md: z.string().max(50_000), channel: z.enum(MARKETING_CHANNELS).default("email"), contact_id: z.string().max(80).nullable().optional() }).strict();
