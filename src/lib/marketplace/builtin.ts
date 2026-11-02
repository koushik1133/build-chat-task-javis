import { AGENT_TEMPLATES } from "@/lib/agent-templates";
import { PACKS } from "@/lib/records/packs";
import { PLAYBOOKS } from "@/lib/agents/playbooks";
import { builtinId, type AgentDefinition, type ListingDTO, type PackDefinition, type PlaybookDefinition } from "./types";

/**
 * Code-defined catalog so the marketplace is never empty: every agent
 * template, record pack and proactive playbook that ships with the product is
 * listed as a built-in, public, free listing.
 *
 * Server-only (packs and playbooks import the DB layer).
 */

const EPOCH = "2026-01-01T00:00:00.000Z";

const AGENT_CATEGORY: Record<string, string> = {
  "lead-generator": "sales",
  "lead-qualifier": "sales",
  "sales-closer": "sales",
  "outreach-writer": "sales",
  "company-researcher": "research",
  "data-analyst": "research",
  "content-writer": "content",
  "social-media-agent": "marketing",
  "support-agent": "support",
  "ops-manager": "operations",
  "meeting-scheduler": "operations",
  "code-reviewer": "operations",
  "documentation-agent": "content",
  "strategy-planner": "research",
};

const PLAYBOOK_CATEGORY: Record<string, string> = {
  "stalled-deal": "sales",
  "lead-follow-up": "sales",
  "unanswered-inbound": "support",
  "ticket-auto-resolve": "support",
  "overdue-card": "operations",
  "social-gap": "marketing",
};

function base(id: string, kind: ListingDTO["kind"], slug: string, title: string): ListingDTO {
  return {
    id,
    kind,
    slug,
    title,
    summary: null,
    description_md: null,
    category: null,
    tags: [],
    definition: null,
    version: 1,
    visibility: "public",
    install_count: 0,
    rating_sum: 0,
    rating_count: 0,
    rating_avg: null,
    builtin: true,
    publisher: "builtin",
    owner: false,
    installed: false,
    created_at: EPOCH,
    updated_at: EPOCH,
    published_at: EPOCH,
  };
}

function tagsFrom(...parts: Array<string | undefined | null>): string[] {
  const out = new Set<string>();
  for (const p of parts) {
    for (const tok of (p ?? "").toLowerCase().split(/[^a-z0-9]+/)) if (tok.length > 2) out.add(tok);
  }
  return [...out].slice(0, 8);
}

function agentListings(): ListingDTO[] {
  return AGENT_TEMPLATES.map((t) => {
    const definition: AgentDefinition = {
      name: t.name,
      role: t.role,
      system_prompt: t.system_prompt,
      tools: t.tools ?? null,
      autonomy_level: t.autonomy_level ?? "approve",
      model: null,
      max_steps: null,
      template_id: t.id,
    };
    const l = base(builtinId("agent", t.id), "agent", t.id, t.name);
    l.summary = t.desc;
    l.category = AGENT_CATEGORY[t.id] ?? "other";
    l.tags = tagsFrom(t.role, ...(t.tools ?? []).map((x) => x.split(".")[0]));
    l.description_md = [
      `**Role:** ${t.role}  `,
      `**Autonomy:** ${definition.autonomy_level}  `,
      `**Tools:** ${t.tools?.length ? t.tools.map((x) => `\`${x}\``).join(", ") : "all tools"}`,
      "",
      "### System prompt",
      "",
      "```",
      t.system_prompt.trim(),
      "```",
      "",
      "### Example tasks",
      "",
      ...t.example_tasks.map((x) => `- ${x}`),
    ].join("\n");
    l.definition = definition;
    return l;
  });
}

function playbookListings(): ListingDTO[] {
  return PLAYBOOKS.map((p) => {
    const definition: PlaybookDefinition = { playbook_id: p.id, enabled: true };
    const l = base(builtinId("playbook", p.id), "playbook", p.id, p.name);
    l.summary = p.description;
    l.category = PLAYBOOK_CATEGORY[p.id] ?? "operations";
    l.tags = tagsFrom("playbook proactive", ...(p.eventTypes ?? []).map((e) => e.split(".")[0]));
    l.description_md = [
      p.description,
      "",
      `Runs automatically when the situation is detected, at most once every **${p.cooldownHours}h** per entity.`,
      "",
      `**Reacts to events:** ${p.eventTypes?.length ? p.eventTypes.map((e) => `\`${e}\``).join(", ") : "scheduled detection only"}  `,
      `**Tools the playbook agent may use:** ${p.defaultTools.map((x) => `\`${x}\``).join(", ")}`,
      "",
      "Installing enables the playbook for your workspace; you can pause it any time from **AI Agents → Playbooks**.",
    ].join("\n");
    l.definition = definition;
    return l;
  });
}

function packListings(): ListingDTO[] {
  return PACKS.map((p) => {
    const definition: PackDefinition = {
      slug: p.slug,
      name: p.name,
      description: p.description,
      icon: p.icon,
      recordTypes: p.recordTypes.map((t) => ({
        slug: t.slug,
        name: t.name,
        icon: t.icon,
        description: t.description,
        fields: t.fields,
        stages: t.stages,
        views: t.views,
        copilot_prompt: t.copilot_prompt,
      })),
    };
    const l = base(builtinId("pack", p.slug), "pack", p.slug, p.name);
    l.summary = p.description;
    l.category = "industry";
    l.tags = tagsFrom(p.name, ...p.recordTypes.map((t) => t.name));
    l.description_md = [
      p.description,
      "",
      `Installs **${p.recordTypes.length}** record type${p.recordTypes.length === 1 ? "" : "s"}:`,
      "",
      ...p.recordTypes.map(
        (t) =>
          `- **${t.name}** — ${t.description} _(${t.fields.length} fields · stages: ${t.stages.map((s) => s.label).join(" → ")})_`
      ),
      "",
      "Every field and stage can be changed after installing.",
    ].join("\n");
    l.definition = definition;
    return l;
  });
}

let cache: ListingDTO[] | null = null;

/** All built-in listings (memoised; cloned on read so callers can annotate). */
export function builtinListings(): ListingDTO[] {
  if (!cache) cache = [...agentListings(), ...playbookListings(), ...packListings()];
  return cache.map((l) => ({ ...l, tags: [...l.tags] }));
}

export function getBuiltinListing(id: string): ListingDTO | null {
  return builtinListings().find((l) => l.id === id) ?? null;
}
