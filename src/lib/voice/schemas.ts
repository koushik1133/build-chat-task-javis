import { z } from "zod";
import { DEFAULT_VOICE, VOICES } from "./twiml";
import { isValidTimeZone, parseHm } from "./window";

/** Request schemas shared by the campaign routes and the agent tool (client-safe). */

const hm = z.string().refine((v) => parseHm(v) !== null, "Use HH:MM");

export const audienceSchema = z
  .object({
    contact_ids: z.array(z.string().min(1).max(100)).max(1000).optional(),
    filter: z
      .object({
        lifecycle: z.string().max(40).optional().nullable(),
        tag: z.string().max(60).optional().nullable(),
        q: z.string().max(120).optional().nullable(),
      })
      .strict()
      .optional()
      .nullable(),
    phones: z.array(z.object({ phone: z.string().min(5).max(30), first_name: z.string().max(80).optional().nullable() }).strict()).max(500).optional(),
  })
  .strict();
export type AudienceBody = z.infer<typeof audienceSchema>;

export const createCampaignSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    script: z.string().trim().min(10).max(3000),
    voice: z.enum(VOICES).default(DEFAULT_VOICE),
    schedule_at: z.string().datetime({ offset: true }).optional().nullable(),
    window_start: hm.default("09:00"),
    window_end: hm.default("18:00"),
    timezone: z.string().max(60).refine(isValidTimeZone, "Unknown timezone").default("UTC"),
    max_attempts: z.number().int().min(1).max(5).default(2),
    audience: audienceSchema.optional(),
    /** Start immediately (or schedule when schedule_at is set) instead of leaving a draft. */
    start: z.boolean().optional(),
  })
  .strict();
export type CreateCampaignBody = z.infer<typeof createCampaignSchema>;
