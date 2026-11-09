import { z } from "zod";
import { DOCUMENT_KINDS, DOCUMENT_STATUSES, MERGE_SOURCES, SIGNING_ORDERS } from "./types";

/** Zod schemas shared by the app routes and the API v1 registry. */

export const MergeFieldSchema = z
  .object({
    key: z.string().trim().min(1).max(60).regex(/^[a-zA-Z0-9_.-]+$/, "letters, digits, dot, dash, underscore"),
    label: z.string().trim().min(1).max(120),
    source: z.enum(MERGE_SOURCES),
    required: z.boolean().optional(),
  })
  .strict();

export const TemplateCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    kind: z.enum(DOCUMENT_KINDS).optional(),
    body_md: z.string().max(200_000).optional(),
    fields: z.array(MergeFieldSchema).max(60).optional(),
    requires_signature: z.boolean().optional(),
    signer_roles: z.array(z.string().trim().min(1).max(60)).max(10).optional(),
  })
  .strict();

export const TemplatePatchSchema = TemplateCreateSchema.partial().strict();

export const SignerInputSchema = z
  .object({ name: z.string().trim().min(1).max(200), email: z.string().trim().email().max(320), role: z.string().trim().max(60).nullable().optional() })
  .strict();

export const DocumentCreateSchema = z
  .object({
    template_id: z.string().max(100).nullable().optional(),
    title: z.string().trim().min(1).max(200).nullable().optional(),
    kind: z.enum(DOCUMENT_KINDS).nullable().optional(),
    body_md: z.string().max(200_000).nullable().optional(),
    merge_data: z.record(z.string().max(60), z.string().max(20_000)).nullable().optional(),
    contact_id: z.string().max(100).nullable().optional(),
    record_id: z.string().max(100).nullable().optional(),
    quote_id: z.string().max(100).nullable().optional(),
    signing_order: z.enum(SIGNING_ORDERS).nullable().optional(),
    expires_in_days: z.number().int().min(1).max(365).nullable().optional(),
    signers: z.array(SignerInputSchema).max(10).nullable().optional(),
  })
  .strict();

export const DocumentPatchSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    body_md: z.string().max(200_000).optional(),
    merge_data: z.record(z.string().max(60), z.string().max(20_000)).optional(),
    signing_order: z.enum(SIGNING_ORDERS).optional(),
    expires_at: z.string().datetime({ offset: true }).nullable().optional(),
    contact_id: z.string().max(100).nullable().optional(),
    signers: z.array(SignerInputSchema).max(10).optional(),
  })
  .strict();

export const DocumentSendSchema = z
  .object({ message: z.string().max(2000).nullable().optional(), expires_in_days: z.number().int().min(1).max(365).nullable().optional() })
  .strict();

export const DocumentListQuerySchema = z.object({
  status: z.enum(DOCUMENT_STATUSES).optional(),
  contact_id: z.string().max(100).optional(),
  q: z.string().max(200).optional(),
});

export const DraftRequestSchema = z
  .object({
    kind: z.enum(DOCUMENT_KINDS),
    instructions: z.string().trim().min(3).max(4000),
    contact_id: z.string().max(100).nullable().optional(),
    template_id: z.string().max(100).nullable().optional(),
  })
  .strict();
