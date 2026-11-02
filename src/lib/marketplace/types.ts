import { z } from "zod";
import { RecordTypeInputSchema } from "@/lib/records/schema";

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

export const AutomationDefinitionSchema = z.object({
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
export type AutomationDefinition = z.infer<typeof AutomationDefinitionSchema>;

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
