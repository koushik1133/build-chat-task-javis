import { z } from "zod";
import { TICKET_PRIORITIES, TICKET_SOURCES, TICKET_STATUSES } from "./sla";

/** Zod schemas shared by the helpdesk routes and agent tools. */

export { errorResponse, parseBody } from "@/lib/money/http";

const Tags = z.array(z.string().max(40)).max(50);

export const CreateTicketSchema = z
  .object({
    subject: z.string().min(1).max(300),
    body: z.string().max(20_000).nullable().optional(),
    priority: z.enum(TICKET_PRIORITIES).optional(),
    source: z.enum(TICKET_SOURCES).optional(),
    contact_id: z.string().max(100).nullable().optional(),
    requester_email: z.string().email().max(200).nullable().optional().or(z.literal("")),
    requester_name: z.string().max(200).nullable().optional(),
    assigned_to: z.string().max(100).nullable().optional(),
    sla_policy_id: z.string().max(100).nullable().optional(),
    tags: Tags.optional(),
    conversation_id: z.string().max(100).nullable().optional(),
  })
  .strict();

export const UpdateTicketSchema = z
  .object({
    subject: z.string().min(1).max(300).optional(),
    status: z.enum(TICKET_STATUSES).optional(),
    priority: z.enum(TICKET_PRIORITIES).optional(),
    assigned_to: z.string().max(100).nullable().optional(),
    sla_policy_id: z.string().max(100).nullable().optional(),
    tags: Tags.optional(),
    contact_id: z.string().max(100).nullable().optional(),
    requester_email: z.string().email().max(200).nullable().optional().or(z.literal("")),
    requester_name: z.string().max(200).nullable().optional(),
  })
  .strict();

export const MessageSchema = z
  .object({
    body: z.string().min(1).max(20_000),
    is_internal: z.boolean().optional(),
  })
  .strict();

const OverrideSchema = z
  .object({
    first_response_minutes: z.number().int().positive().max(525_600).optional(),
    resolution_minutes: z.number().int().positive().max(525_600).optional(),
  })
  .strict();

export const PolicySchema = z
  .object({
    name: z.string().min(1).max(100),
    first_response_minutes: z.number().int().positive().max(525_600).optional(),
    resolution_minutes: z.number().int().positive().max(525_600).optional(),
    business_hours_only: z.boolean().optional(),
    priority_overrides: z
      .object({
        low: OverrideSchema.optional(),
        normal: OverrideSchema.optional(),
        high: OverrideSchema.optional(),
        urgent: OverrideSchema.optional(),
      })
      .strict()
      .nullable()
      .optional(),
    is_default: z.boolean().optional(),
  })
  .strict();

export const PolicyPatchSchema = PolicySchema.partial();

export const PortalTicketSchema = z
  .object({
    subject: z.string().min(1).max(300),
    body: z.string().min(1).max(20_000),
    priority: z.enum(["low", "normal", "high"]).optional(),
  })
  .strict();

export const WidgetTicketSchema = z
  .object({
    name: z.string().min(1).max(200),
    email: z.string().email().max(200),
    subject: z.string().min(1).max(300),
    body: z.string().min(1).max(20_000),
  })
  .strict();
