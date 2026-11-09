import { z } from "zod";
import { RecordTypeInputSchema } from "@/lib/records/schema";
import { ConditionNodeSchema, ScheduleConfigSchema, StepsSchema } from "@/lib/automations/schema";
import type { AutomationDefinition as EngineAutomationDefinition, Step, TriggerConfig } from "@/lib/automations/types";

/**
 * Marketplace contracts — client-safe (no DB imports).
 *
 * A listing wraps a *portable definition*: everything needed to recreate an
 * agent, playbook subscription, automation or record pack in another
 * workspace, with ids and secrets stripped out.
 */

export const LISTING_KINDS = ["agent", "playbook", "automation", "pack"] as const;
export type ListingKind = (typeof LISTING_KINDS)[number];

export const VISIBILITIES = ["private", "org", "public"] as const;
export type Visibility = (typeof VISIBILITIES)[number];

export const CATEGORIES = ["sales", "marketing", "support", "operations", "finance", "content", "research", "industry", "other"] as const;
export type Category = (typeof CATEGORIES)[number];

export const SORTS = ["popular", "newest", "rating", "title"] as const;
export type Sort = (typeof SORTS)[number];

export const KIND_LABELS: Record<ListingKind, string> = { agent: "Agent", playbook: "Playbook", automation: "Automation", pack: "Record pack" };
export const KIND_PLURALS: Record<ListingKind, string> = { agent: "Agents", playbook: "Playbooks", automation: "Automations", pack: "Record packs" };

const toolName = z.string().regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/, "tool names look like module.action");

export const AgentDefinitionSchema = z.object({
  name: z.string().trim().min(1).max(120),
  role: z.string().trim().min(1).max(120),
  system_prompt: z.string().max(20_000).nullable(),
  /** Tool allowlist; null = all tools. */
  tools: z.array(toolName).max(64).nullable(),
  autonomy_level: z.enum(["draft", "approve", "auto"]),
  model: z.string().max(120).nullable(),
  max_steps: z.number().int().min(1).max(500).nullable(),
  template_id: z.string().max(120).nullable().optional(),
});
export type AgentDefinition = z.infer<typeof AgentDefinitionSchema>;

export const PlaybookDefinitionSchema = z.object({
  /** Id of a built-in playbook (src/lib/agents/playbooks). */
  playbook_id: z.string().trim().min(1).max(80),
  enabled: z.boolean().default(true),
  settings: z.record(z.unknown()).optional(),
});
export type PlaybookDefinition = z.infer<typeof PlaybookDefinitionSchema>;

/** Pre-v2 automation listing (trigger_event + action_type + action_config). Still importable via legacyToV2. */
export const LegacyAutomationDefinitionSchema = z.object({
  name: z.string().trim().min(1).max(200),
  trigger_event: z.string().trim().min(1).max(120),
  action_type: z.string().trim().min(1).max(120),
  kanban_label: z.string().max(200).nullable(),
  /** Scrubbed: only non-secret, non-id keys survive (see scrubAutomationConfig). */
  action_config: z.record(z.unknown()),
  schedule_time: z.string().max(20).nullable(),
  schedule_timezone: z.string().max(64).nullable(),
  schedule_days: z.string().max(40).nullable(),
});
export type LegacyAutomationDefinition = z.infer<typeof LegacyAutomationDefinitionSchema>;

/** Portable trigger config: no inbound webhook token (the installer mints its own). */
export const PortableTriggerConfigSchema = z
  .object({
    event_type: z.string().trim().min(1).max(120).optional(),
    filter: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
    schedule: ScheduleConfigSchema.optional(),
  })
  .strict();

/** v2 automation listing: the engine definition (trigger / conditions / steps) scrubbed of ids, secrets and endpoints. */
export const AutomationV2DefinitionSchema = z.object({
  schema: z.literal(2),
  name: z.string().trim().min(1).max(200),
  description: z.string().max(2000).nullable().optional(),
  trigger_type: z.enum(["event", "schedule", "webhook", "manual"]),
  trigger_config: PortableTriggerConfigSchema.default({}),
  conditions: ConditionNodeSchema.nullable().default(null),
  steps: StepsSchema,
  autonomy: z.enum(["auto", "approve"]).default("approve"),
});
export type AutomationV2Definition = z.infer<typeof AutomationV2DefinitionSchema>;

export const AutomationDefinitionSchema = z.union([AutomationV2DefinitionSchema, LegacyAutomationDefinitionSchema]);
export type AutomationDefinition = z.infer<typeof AutomationDefinitionSchema>;

export function isV2AutomationDefinition(d: AutomationDefinition): d is AutomationV2Definition {
  return (d as { schema?: unknown }).schema === 2;
}

export const PackRecordTypeSchema = RecordTypeInputSchema.extend({
  slug: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
});
export const PackDefinitionSchema = z.object({
  slug: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
  name: z.string().trim().min(1).max(80),
  description: z.string().max(1000),
  icon: z.string().max(40),
  recordTypes: z.array(PackRecordTypeSchema).min(1).max(20),
});
export type PackDefinition = z.infer<typeof PackDefinitionSchema>;

export const DEFINITION_SCHEMAS: Record<ListingKind, z.ZodTypeAny> = {
  agent: AgentDefinitionSchema,
  playbook: PlaybookDefinitionSchema,
  automation: AutomationDefinitionSchema,
  pack: PackDefinitionSchema,
};

export type ListingDefinition =
  | { kind: "agent"; definition: AgentDefinition }
  | { kind: "playbook"; definition: PlaybookDefinition }
  | { kind: "automation"; definition: AutomationDefinition }
  | { kind: "pack"; definition: PackDefinition };

/** Validate a raw definition for a kind; throws a ZodError with a readable message. */
export function parseDefinition(kind: ListingKind, raw: unknown): ListingDefinition {
  const parsed = DEFINITION_SCHEMAS[kind].parse(raw);
  return { kind, definition: parsed } as ListingDefinition;
}

export function isListingKind(v: unknown): v is ListingKind {
  return typeof v === "string" && (LISTING_KINDS as readonly string[]).includes(v);
}
export function isVisibility(v: unknown): v is Visibility {
  return typeof v === "string" && (VISIBILITIES as readonly string[]).includes(v);
}

/* ─── Automation scrubbing ───────────────────────────────────────────────── */

/** Keys of `automations.action_config` that are safe to share: templates and routing, never endpoints or ids. */
export const AUTOMATION_SAFE_KEYS = ["subject", "message", "prompt", "deliver_via", "playbook_id"] as const;

export interface ScrubResult {
  config: Record<string, unknown>;
  /** Keys that were dropped because they carry secrets, endpoints or workspace ids. */
  removed: string[];
}

/** Allowlist scrub: anything not in AUTOMATION_SAFE_KEYS is removed (webhook URLs, recipients, agent/entity ids…). */
export function scrubAutomationConfig(raw: unknown): ScrubResult {
  const removed: string[] = [];
  const config: Record<string, unknown> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { config, removed };
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if ((AUTOMATION_SAFE_KEYS as readonly string[]).includes(k)) {
      if (k === "deliver_via") {
        if (Array.isArray(v)) config[k] = v.filter((x): x is string => typeof x === "string").slice(0, 10);
      } else if (typeof v === "string") {
        // Belt and braces: a template that embeds a URL or token-looking blob is still dropped.
        if (/https?:\/\/|hooks\.slack\.com|[A-Za-z0-9_-]{32,}/.test(v)) removed.push(k);
        else config[k] = v.slice(0, 4000);
      }
    } else {
      removed.push(k);
    }
  }
  return { config, removed };
}

/** Placeholder for a webhook endpoint stripped on export; the installer must replace it before enabling. */
export const WEBHOOK_URL_PLACEHOLDER = "https://example.invalid/replace-me";
/** Templated placeholder for a stripped literal recipient; renders empty so the step fails loudly until it is set. */
export const NOTIFY_TO_PLACEHOLDER = "{{recipient}}";

/** Templated references (`{{ … }}`) are portable; literal ids, addresses and URLs are not. */
const SECRET_LIKE = /https?:\/\/|hooks\.slack\.com|[A-Za-z0-9_-]{32,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|@/i;
function portableString(v: string): boolean {
  return v.trim().startsWith("{{") || !SECRET_LIKE.test(v);
}

function scrubRecord(input: Record<string, unknown>, path: string, removed: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (typeof v === "string") {
      if (portableString(v)) out[k] = v.slice(0, 4000);
      else removed.push(`${path}.${k}`);
    } else if (v && typeof v === "object" && !Array.isArray(v)) {
      out[k] = scrubRecord(v as Record<string, unknown>, `${path}.${k}`, removed);
    } else if (/(^|_)(id|ids|token|secret|key|url|webhook)$/i.test(k)) {
      removed.push(`${path}.${k}`);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** Allow-list scrub of one step. Ids, endpoints, recipients and secrets go; templates, routing and copy stay. */
export function scrubStep(step: Step, removed: string[]): Step {
  const at = `steps.${step.id}`;
  const base = { id: step.id, kind: step.kind, ...(step.name ? { name: step.name } : {}) };
  switch (step.kind) {
    case "tool":
      return { ...base, kind: "tool", config: { tool: step.config.tool, input: scrubRecord(step.config.input ?? {}, `${at}.input`, removed) } };
    case "delay":
      return { ...base, kind: "delay", config: { ...(step.config.minutes != null ? { minutes: step.config.minutes } : {}), ...(step.config.until ? { until: step.config.until } : {}) } };
    case "branch":
      return { ...base, kind: "branch", config: { conditions: step.config.conditions, then: step.config.then ?? null, else: step.config.else ?? null } };
    case "agent": {
      if (step.config.agent_id) removed.push(`${at}.agent_id`);
      const prompt = portableString(step.config.prompt) ? step.config.prompt : (removed.push(`${at}.prompt`), "Describe what the agent should do.");
      return { ...base, kind: "agent", config: { agent_id: "", prompt } };
    }
    case "notify": {
      const to = step.config.to.trim().startsWith("{{") ? step.config.to : (removed.push(`${at}.to`), NOTIFY_TO_PLACEHOLDER);
      const body = portableString(step.config.body) ? step.config.body : (removed.push(`${at}.body`), "(edit this message)");
      const subject = step.config.subject && portableString(step.config.subject) ? step.config.subject : step.config.subject ? (removed.push(`${at}.subject`), undefined) : undefined;
      const contact_id = step.config.contact_id && step.config.contact_id.trim().startsWith("{{") ? step.config.contact_id : step.config.contact_id ? (removed.push(`${at}.contact_id`), undefined) : undefined;
      return { ...base, kind: "notify", config: { channel: step.config.channel, to, body, ...(subject ? { subject } : {}), ...(step.config.marketing ? { marketing: true } : {}), ...(contact_id ? { contact_id } : {}) } };
    }
    case "webhook": {
      removed.push(`${at}.url`);
      if (step.config.secret) removed.push(`${at}.secret`);
      return { ...base, kind: "webhook", config: { url: WEBHOOK_URL_PLACEHOLDER, ...(step.config.payload ? { payload: scrubRecord(step.config.payload, `${at}.payload`, removed) } : {}) } };
    }
    case "approval":
      return { ...base, kind: "approval", config: { title: step.config.title, ...(step.config.description ? { description: step.config.description } : {}) } };
  }
}

export interface ScrubV2Result {
  definition: AutomationV2Definition;
  removed: string[];
}

/** Engine definition → portable v2 listing definition. */
export function scrubAutomationV2(def: EngineAutomationDefinition): ScrubV2Result {
  const removed: string[] = [];
  const tc: TriggerConfig = def.trigger_config ?? {};
  if (tc.webhook) removed.push("trigger_config.webhook");
  const trigger_config: AutomationV2Definition["trigger_config"] = {
    ...(tc.event_type ? { event_type: tc.event_type } : {}),
    ...(tc.filter ? { filter: tc.filter } : {}),
    ...(tc.schedule ? { schedule: tc.schedule } : {}),
  };
  const steps = def.steps.map((s) => scrubStep(s, removed));
  const definition = AutomationV2DefinitionSchema.parse({
    schema: 2,
    name: def.name,
    description: def.description ?? null,
    trigger_type: def.trigger_type,
    trigger_config,
    conditions: def.conditions ?? null,
    steps,
    autonomy: def.autonomy,
  });
  return { definition, removed };
}

/* ─── Listing DTO ────────────────────────────────────────────────────────── */

export type Publisher = "builtin" | "you" | "community";

export interface ListingDTO {
  id: string;
  kind: ListingKind;
  slug: string;
  title: string;
  summary: string | null;
  description_md: string | null;
  category: string | null;
  tags: string[];
  definition: unknown;
  version: number;
  visibility: Visibility;
  install_count: number;
  rating_sum: number;
  rating_count: number;
  rating_avg: number | null;
  /** True for the code-defined catalog (templates, packs, playbooks). */
  builtin: boolean;
  publisher: Publisher;
  /** The caller's org published this listing. */
  owner: boolean;
  /** The caller's org has installed this listing version. */
  installed: boolean;
  created_at: string;
  updated_at: string;
  published_at: string | null;
}

export interface ReviewDTO {
  id: string;
  listing_id: string;
  rating: number;
  body: string | null;
  /** True when written by the caller's org. */
  mine: boolean;
  created_at: string;
}

export interface CatalogQuery {
  q?: string | null;
  kind?: ListingKind | null;
  category?: string | null;
  sort?: Sort | null;
  limit?: number | null;
}

export interface InstallResult {
  listing: ListingDTO;
  entityKind: ListingKind;
  entityId: string;
  /** False when this listing version was already installed (idempotent). */
  created: boolean;
  /** Human note, e.g. "automation installed paused — add a recipient". */
  note: string | null;
}

export const BUILTIN_PREFIX = "builtin:";

export function isBuiltinId(id: string): boolean {
  return id.startsWith(BUILTIN_PREFIX);
}

export function builtinId(kind: ListingKind, key: string): string {
  return `${BUILTIN_PREFIX}${kind}:${key}`;
}

export function ratingAvg(sum: number, count: number): number | null {
  return count > 0 ? Math.round((sum / count) * 10) / 10 : null;
}

export function slugifyListing(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 60);
}

/** Case-insensitive, token-based match used by both the catalog and the search tool. */
export function matchesQuery(l: Pick<ListingDTO, "title" | "summary" | "tags" | "category" | "kind">, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  const hay = [l.title, l.summary ?? "", l.category ?? "", l.kind, ...l.tags].join(" ").toLowerCase();
  return needle.split(/\s+/).every((tok) => hay.includes(tok));
}

export function sortListings(list: ListingDTO[], sort: Sort | null | undefined): ListingDTO[] {
  const out = [...list];
  switch (sort ?? "popular") {
    case "newest":
      out.sort((a, b) => (b.published_at ?? b.created_at).localeCompare(a.published_at ?? a.created_at));
      break;
    case "rating":
      out.sort((a, b) => (b.rating_avg ?? 0) - (a.rating_avg ?? 0) || b.rating_count - a.rating_count || a.title.localeCompare(b.title));
      break;
    case "title":
      out.sort((a, b) => a.title.localeCompare(b.title));
      break;
    default:
      out.sort((a, b) => b.install_count - a.install_count || (b.rating_avg ?? 0) - (a.rating_avg ?? 0) || a.title.localeCompare(b.title));
  }
  return out;
}
