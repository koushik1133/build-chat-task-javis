import { z } from "zod";
import { CONDITION_OPS, RUN_LIMITS, STEP_KINDS, type ConditionNode, type Step } from "./types";

/** Zod schemas for the v2 automation definition (client-safe). */

const StepId = z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/, "step ids are 1–40 chars of letters, digits, _ or -");

export const ConditionRuleSchema = z
  .object({
    field: z.string().trim().min(1).max(200),
    op: z.enum(CONDITION_OPS),
    value: z.unknown().optional(),
  })
  .strict();

export const ConditionNodeSchema: z.ZodType<ConditionNode> = z.lazy(() =>
  z.union([
    ConditionRuleSchema,
    z
      .object({
        all: z.array(ConditionNodeSchema).max(50).optional(),
        any: z.array(ConditionNodeSchema).max(50).optional(),
      })
      .strict(),
  ])
);

export const ScheduleConfigSchema = z
  .object({
    time: z.string().regex(/^\d{1,2}:\d{2}$/, "HH:MM"),
    timezone: z.string().min(1).max(64),
    days: z.string().min(1).max(20),
  })
  .strict();

export const TriggerConfigSchema = z
  .object({
    event_type: z.string().trim().min(1).max(120).optional(),
    filter: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
    schedule: ScheduleConfigSchema.optional(),
    webhook: z.object({ token: z.string().min(8).max(200) }).strict().optional(),
  })
  .strict();

const TemplatedRecord = z.record(z.unknown());

export const ToolStepConfigSchema = z.object({ tool: z.string().regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/), input: TemplatedRecord }).strict();
export const DelayStepConfigSchema = z
  .object({ minutes: z.number().int().min(1).max(RUN_LIMITS.maxDelayDays * 24 * 60).optional(), until: z.string().max(200).optional() })
  .strict()
  .refine((c) => c.minutes !== undefined || c.until !== undefined, "set minutes or until");
export const BranchStepConfigSchema = z.object({ conditions: ConditionNodeSchema, then: StepId.nullable().optional(), else: z.union([StepId, z.literal("end")]).nullable().optional() }).strict();
export const AgentStepConfigSchema = z.object({ agent_id: z.string().max(100).describe("Empty until the user picks an agent; the step fails at run time without one"), prompt: z.string().min(1).max(4000) }).strict();
export const NotifyStepConfigSchema = z
  .object({
    channel: z.enum(["email", "sms", "in_app"]),
    to: z.string().min(1).max(500),
    subject: z.string().max(300).optional(),
    body: z.string().min(1).max(8000),
    marketing: z.boolean().optional(),
    contact_id: z.string().max(300).optional(),
  })
  .strict();
export const WebhookStepConfigSchema = z.object({ url: z.string().url().max(2000), secret: z.string().max(200).optional(), payload: TemplatedRecord.optional() }).strict();
export const ApprovalStepConfigSchema = z.object({ title: z.string().min(1).max(200), description: z.string().max(2000).optional() }).strict();

const base = { id: StepId, name: z.string().max(120).optional() };

export const StepSchema: z.ZodType<Step> = z.discriminatedUnion("kind", [
  z.object({ ...base, kind: z.literal("tool"), config: ToolStepConfigSchema }).strict(),
  z.object({ ...base, kind: z.literal("delay"), config: DelayStepConfigSchema }).strict(),
  z.object({ ...base, kind: z.literal("branch"), config: BranchStepConfigSchema }).strict(),
  z.object({ ...base, kind: z.literal("agent"), config: AgentStepConfigSchema }).strict(),
  z.object({ ...base, kind: z.literal("notify"), config: NotifyStepConfigSchema }).strict(),
  z.object({ ...base, kind: z.literal("webhook"), config: WebhookStepConfigSchema }).strict(),
  z.object({ ...base, kind: z.literal("approval"), config: ApprovalStepConfigSchema }).strict(),
]) as z.ZodType<Step>;

export const StepsSchema = z
  .array(StepSchema)
  .max(RUN_LIMITS.maxSteps)
  .superRefine((steps, ctx) => {
    const ids = new Set<string>();
    for (const s of steps) {
      if (ids.has(s.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate step id "${s.id}"` });
      ids.add(s.id);
    }
    for (const s of steps) {
      if (s.kind !== "branch") continue;
      for (const target of [s.config.then, s.config.else]) {
        if (target && target !== "end" && !ids.has(target)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `branch "${s.id}" points at unknown step "${target}"` });
      }
    }
  });

export const AutomationDefinitionSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    description: z.string().max(2000).nullable().optional(),
    trigger_type: z.enum(["event", "schedule", "webhook", "manual"]),
    trigger_config: TriggerConfigSchema.default({}),
    conditions: ConditionNodeSchema.nullable().default(null),
    steps: StepsSchema,
    autonomy: z.enum(["auto", "approve"]).default("approve"),
    enabled: z.boolean().default(false),
  })
  .strict()
  .superRefine((d, ctx) => {
    if (d.trigger_type === "event" && !d.trigger_config.event_type) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["trigger_config", "event_type"], message: "event_type is required for event triggers" });
    if (d.trigger_type === "schedule" && !d.trigger_config.schedule) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["trigger_config", "schedule"], message: "schedule is required for schedule triggers" });
  });

export type AutomationDefinitionInput = z.input<typeof AutomationDefinitionSchema>;

/** PATCH body: any subset of the definition. */
export const AutomationPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    description: z.string().max(2000).nullable().optional(),
    trigger_type: z.enum(["event", "schedule", "webhook", "manual"]).optional(),
    trigger_config: TriggerConfigSchema.optional(),
    conditions: ConditionNodeSchema.nullable().optional(),
    steps: StepsSchema.optional(),
    autonomy: z.enum(["auto", "approve"]).optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

export const STEP_KIND_SET: ReadonlySet<string> = new Set(STEP_KINDS);
