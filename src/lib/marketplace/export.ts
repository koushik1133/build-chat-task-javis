import { query, queryOne } from "@/lib/dsql";
import { getPlaybook } from "@/lib/agents/playbooks";
import { getPack } from "@/lib/records/packs";
import { getType, listTypes } from "@/lib/records/store";
import type { RecordType } from "@/lib/records/types";
import {
  parseDefinition,
  scrubAutomationConfig,
  slugifyListing,
  type AgentDefinition,
  type AutomationDefinition,
  type ListingKind,
  type PackDefinition,
  type PlaybookDefinition,
} from "./types";

/**
 * Turn something that lives in a workspace into a portable listing payload.
 * Nothing here writes; `publishListing` (catalog.ts) persists the result.
 */

export interface ExportedListing {
  kind: ListingKind;
  slug: string;
  title: string;
  summary: string | null;
  description_md: string | null;
  category: string | null;
  tags: string[];
  definition: unknown;
  /** Keys dropped from an automation config so the publisher can be told. */
  scrubbed: string[];
}

interface AgentRow {
  id: string;
  name: string;
  role: string;
  system_prompt: string | null;
  template_id: string | null;
  tools: string | null;
  model: string | null;
  autonomy_level: string | null;
  max_steps: number | null;
}

function parseJsonArray(raw: string | null): string[] | null {
  if (!raw) return null;
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : null;
  } catch {
    return null;
  }
}

function parseJsonObject(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const v: unknown = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

async function exportAgent(dataId: string, agentId: string): Promise<ExportedListing> {
  const row = await queryOne<AgentRow>(
    `SELECT id, name, role, system_prompt, template_id, tools, model, autonomy_level, max_steps
       FROM agents WHERE id::text = $1 AND user_id = $2 AND deleted_at IS NULL`,
    [agentId, dataId]
  ).catch(async () =>
    queryOne<AgentRow>(`SELECT id, name, role, system_prompt, template_id, tools, model, autonomy_level, max_steps FROM agents WHERE id::text = $1 AND user_id = $2`, [agentId, dataId])
  );
  if (!row) throw new Error("Agent not found");
  const autonomy = row.autonomy_level === "draft" || row.autonomy_level === "auto" ? row.autonomy_level : "approve";
  const definition: AgentDefinition = {
    name: row.name,
    role: row.role,
    system_prompt: row.system_prompt,
    tools: parseJsonArray(row.tools),
    autonomy_level: autonomy,
    // Model names are workspace/provider specific; shipped as a hint only.
    model: row.model,
    max_steps: row.max_steps ? Number(row.max_steps) : null,
    template_id: row.template_id,
  };
  parseDefinition("agent", definition);
  return {
    kind: "agent",
    slug: slugifyListing(row.name),
    title: row.name,
    summary: `${row.role} agent${definition.tools ? ` using ${definition.tools.length} tool${definition.tools.length === 1 ? "" : "s"}` : ""}.`,
    description_md: [
      `**Role:** ${row.role}  `,
      `**Autonomy:** ${autonomy}  `,
      `**Tools:** ${definition.tools?.length ? definition.tools.map((x) => `\`${x}\``).join(", ") : "all tools"}`,
      "",
      "### System prompt",
      "",
      "```",
      (row.system_prompt ?? "").trim(),
      "```",
    ].join("\n"),
    category: null,
    tags: [slugifyListing(row.role)].filter(Boolean),
    definition,
    scrubbed: [],
  };
}

async function exportPlaybook(dataId: string, playbookId: string): Promise<ExportedListing> {
  const pb = getPlaybook(playbookId);
  if (!pb) throw new Error("Playbook not found");
  const setting = await queryOne<{ enabled: boolean | null }>(`SELECT enabled FROM playbook_settings WHERE user_id = $1 AND playbook_id = $2`, [dataId, pb.id]).catch(() => null);
  const definition: PlaybookDefinition = { playbook_id: pb.id, enabled: setting ? setting.enabled !== false : true };
  return {
    kind: "playbook",
    slug: slugifyListing(pb.name),
    title: pb.name,
    summary: pb.description,
    description_md: `${pb.description}\n\nCooldown: **${pb.cooldownHours}h** per entity. Tools: ${pb.defaultTools.map((x) => `\`${x}\``).join(", ")}.`,
    category: null,
    tags: ["playbook"],
    definition,
    scrubbed: [],
  };
}

interface AutomationRow {
  id: string;
  name: string;
  trigger_event: string;
  action_type: string;
  kanban_label: string | null;
  action_config: string | null;
  schedule_time: string | null;
  schedule_timezone: string | null;
  schedule_days: string | null;
}

async function exportAutomation(dataId: string, automationId: string): Promise<ExportedListing> {
  const row = await queryOne<AutomationRow>(
    `SELECT id, name, trigger_event, action_type, kanban_label, action_config, schedule_time, schedule_timezone, schedule_days
       FROM automations WHERE id::text = $1 AND user_id = $2`,
    [automationId, dataId]
  );
  if (!row) throw new Error("Automation not found");
  const scrub = scrubAutomationConfig(parseJsonObject(row.action_config));
  const definition: AutomationDefinition = {
    name: row.name,
    trigger_event: row.trigger_event,
    action_type: row.action_type,
    kanban_label: row.kanban_label,
    action_config: scrub.config,
    schedule_time: row.schedule_time,
    schedule_timezone: row.schedule_timezone,
    schedule_days: row.schedule_days,
  };
  parseDefinition("automation", definition);
  const when = row.schedule_time ? `daily at ${row.schedule_time}${row.schedule_timezone ? ` (${row.schedule_timezone})` : ""}` : `when ${row.trigger_event}${row.kanban_label ? ` · label "${row.kanban_label}"` : ""}`;
  return {
    kind: "automation",
    slug: slugifyListing(row.name),
    title: row.name,
    summary: `${row.action_type} ${when}.`,
    description_md: [
      `**Trigger:** ${row.trigger_event}  `,
      `**Action:** ${row.action_type}`,
      "",
      scrub.removed.length
        ? `Workspace-specific settings were removed before publishing (${scrub.removed.join(", ")}); fill them in after installing. The automation installs **paused**.`
        : "The automation installs **paused** so you can review it before it runs.",
    ].join("\n"),
    category: null,
    tags: [slugifyListing(row.action_type), slugifyListing(row.trigger_event)].filter(Boolean),
    definition,
    scrubbed: scrub.removed,
  };
}

function typeToPackType(t: RecordType): PackDefinition["recordTypes"][number] {
  return {
    slug: t.slug,
    name: t.name,
    icon: t.icon ?? "box",
    description: t.description ?? "",
    fields: t.fields,
    stages: t.stages,
    views: t.views,
    copilot_prompt: t.copilot_prompt ?? "",
  };
}

/**
 * Pack export accepts a built-in pack slug, the `pack_slug` of installed types,
 * or a single record type slug / id (published as a one-type pack).
 */
async function exportPack(dataId: string, entityId: string): Promise<ExportedListing> {
  const builtin = getPack(entityId);
  let definition: PackDefinition;
  if (builtin) {
    // Prefer the workspace's customised copies of the pack's types when present.
    const types = await listTypes(dataId);
    const own = types.filter((t) => t.pack_slug === builtin.slug);
    definition = {
      slug: builtin.slug,
      name: builtin.name,
      description: builtin.description,
      icon: builtin.icon,
      recordTypes: own.length
        ? own.map(typeToPackType)
        : builtin.recordTypes.map((t) => ({ slug: t.slug, name: t.name, icon: t.icon, description: t.description, fields: t.fields, stages: t.stages, views: t.views, copilot_prompt: t.copilot_prompt })),
    };
  } else {
    const types = await listTypes(dataId);
    const grouped = types.filter((t) => t.pack_slug === entityId);
    if (grouped.length > 0) {
      definition = { slug: entityId, name: entityId.replace(/-/g, " "), description: `${grouped.length} record types`, icon: grouped[0].icon ?? "box", recordTypes: grouped.map(typeToPackType) };
    } else {
      const single = await getType(dataId, entityId);
      if (!single) throw new Error("Record type or pack not found");
      definition = { slug: single.slug, name: single.name, description: single.description ?? "", icon: single.icon ?? "box", recordTypes: [typeToPackType(single)] };
    }
  }
  parseDefinition("pack", definition);
  return {
    kind: "pack",
    slug: definition.slug,
    title: definition.name,
    summary: definition.description || `${definition.recordTypes.length} record type${definition.recordTypes.length === 1 ? "" : "s"}.`,
    description_md: [
      definition.description,
      "",
      ...definition.recordTypes.map((t) => `- **${t.name}** — ${t.description || "record type"} _(${t.fields.length} fields · ${t.stages.length} stages)_`),
    ].join("\n"),
    category: "industry",
    tags: definition.recordTypes.map((t) => t.slug).slice(0, 8),
    definition,
    scrubbed: [],
  };
}

/** Build a portable listing payload from a workspace entity. Throws "… not found" when it does not belong to `dataId`. */
export async function exportAsListing(dataId: string, kind: ListingKind, entityId: string): Promise<ExportedListing> {
  switch (kind) {
    case "agent":
      return exportAgent(dataId, entityId);
    case "playbook":
      return exportPlaybook(dataId, entityId);
    case "automation":
      return exportAutomation(dataId, entityId);
    case "pack":
      return exportPack(dataId, entityId);
  }
}

/** Entities in the workspace that can be published, for the "Publish from my workspace" picker. */
export async function listPublishable(dataId: string): Promise<Record<ListingKind, Array<{ id: string; label: string; hint?: string }>>> {
  const [agents, automations, types] = await Promise.all([
    query<{ id: string; name: string; role: string }>(`SELECT id::text AS id, name, role FROM agents WHERE user_id = $1 AND deleted_at IS NULL ORDER BY name ASC LIMIT 200`, [dataId]).catch(() =>
      query<{ id: string; name: string; role: string }>(`SELECT id::text AS id, name, role FROM agents WHERE user_id = $1 ORDER BY name ASC LIMIT 200`, [dataId]).catch(() => [])
    ),
    query<{ id: string; name: string; action_type: string }>(`SELECT id::text AS id, name, action_type FROM automations WHERE user_id = $1 ORDER BY name ASC LIMIT 200`, [dataId]).catch(() => []),
    listTypes(dataId).catch(() => [] as RecordType[]),
  ]);
  const { PLAYBOOKS } = await import("@/lib/agents/playbooks");
  const packGroups = new Map<string, number>();
  for (const t of types) if (t.pack_slug) packGroups.set(t.pack_slug, (packGroups.get(t.pack_slug) ?? 0) + 1);
  return {
    agent: agents.filter((a) => !a.name.startsWith("Playbook: ")).map((a) => ({ id: a.id, label: a.name, hint: a.role })),
    playbook: PLAYBOOKS.map((p) => ({ id: p.id, label: p.name, hint: `${p.cooldownHours}h cooldown` })),
    automation: automations.map((a) => ({ id: a.id, label: a.name, hint: a.action_type })),
    pack: [
      ...[...packGroups.entries()].map(([slug, n]) => ({ id: slug, label: getPack(slug)?.name ?? slug, hint: `${n} type${n === 1 ? "" : "s"} (pack)` })),
      ...types.map((t) => ({ id: t.slug, label: t.name, hint: `${t.fields.length} fields (single type)` })),
    ],
  };
}
