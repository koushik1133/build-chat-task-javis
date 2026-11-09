import { randomUUID } from "crypto";
import { z } from "zod";
import { query, queryOne } from "@/lib/dsql";
import { tableExists } from "@/lib/table-exists";
import { installPack, getPack } from "@/lib/records/packs";
import { ensureDefaultCalendar } from "@/lib/calendar/booking";
import { createPolicy, getDefaultPolicy } from "@/lib/helpdesk/tickets";
import { AGENT_TEMPLATES, type AgentTemplate } from "@/lib/agent-templates";
import { PLAYBOOKS } from "@/lib/agents/playbooks";
import { recordAudit } from "@/lib/audit";
import { mergeOrgSettings, readOrgSettingsRaw } from "./status";

/**
 * Finish-onboarding side effects. Idempotent: every step checks before it
 * creates, so re-posting the same payload is a no-op apart from the timestamp.
 */

export const CompleteBody = z
  .object({
    industry: z.string().trim().min(1).max(40),
    packs: z.array(z.string().trim().min(1).max(40)).max(10).default([]),
    modules: z
      .object({
        booking: z.boolean().default(false),
        invoicing: z.boolean().default(true),
        helpdesk: z.boolean().default(false),
        inventory: z.boolean().default(false),
        voice_mail: z.boolean().default(false),
      })
      .strict()
      .default({}),
    ai: z
      .object({
        autonomy: z.enum(["draft", "approve", "auto"]).default("approve"),
        playbooks: z.boolean().default(true),
        outcome_pricing: z.boolean().default(false),
      })
      .strict()
      .default({}),
  })
  .strict();
export type CompleteInput = z.infer<typeof CompleteBody>;

export interface CompleteResult {
  completedAt: string;
  packsInstalled: string[];
  bookingTypeId: string | null;
  slaPolicyId: string | null;
  agentsCreated: number;
  warnings: string[];
}

/** Three starter agents that fit an industry (pack slug). */
export function starterAgentsFor(industry: string): AgentTemplate[] {
  const ind = industry.toLowerCase();
  const pick = (ids: string[]) => ids.map((id) => AGENT_TEMPLATES.find((t) => t.id === id)).filter((t): t is AgentTemplate => Boolean(t));
  if (/health|dental|clinic/.test(ind)) return pick(["support-agent", "meeting-scheduler", "ops-manager"]);
  if (/agency|marketing|social/.test(ind)) return pick(["content-writer", "social-media-agent", "lead-generator"]);
  if (/legal|finance|account/.test(ind)) return pick(["documentation-agent", "company-researcher", "ops-manager"]);
  if (/realestate|real-estate|property/.test(ind)) return pick(["lead-qualifier", "outreach-writer", "meeting-scheduler"]);
  if (/ecommerce|retail|shop/.test(ind)) return pick(["support-agent", "data-analyst", "social-media-agent"]);
  if (/field|fleet|service|trade/.test(ind)) return pick(["meeting-scheduler", "support-agent", "ops-manager"]);
  if (/startup|saas|software/.test(ind)) return pick(["lead-generator", "content-writer", "data-analyst"]);
  if (/nonprofit|charity/.test(ind)) return pick(["outreach-writer", "content-writer", "data-analyst"]);
  if (/education|school|course/.test(ind)) return pick(["support-agent", "content-writer", "meeting-scheduler"]);
  if (/hiring|recruit/.test(ind)) return pick(["company-researcher", "outreach-writer", "meeting-scheduler"]);
  return pick(["lead-generator", "support-agent", "ops-manager"]);
}

export async function completeOnboarding(dataId: string, actorId: string, input: CompleteInput): Promise<CompleteResult> {
  const warnings: string[] = [];
  const step = async <T>(label: string, fn: () => Promise<T>): Promise<T | null> => {
    try {
      return await fn();
    } catch (err) {
      warnings.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  };

  // Packs (industry pack first, then any extras).
  const packSlugs = Array.from(new Set([input.industry, ...input.packs].filter((s) => getPack(s))));
  const packsInstalled: string[] = [];
  for (const slug of packSlugs) {
    const ok = await step(`pack ${slug}`, () => installPack(dataId, slug));
    if (ok) packsInstalled.push(slug);
  }

  // Booking: default calendar + one booking type.
  let bookingTypeId: string | null = null;
  if (input.modules.booking) {
    bookingTypeId = await step("booking", async () => {
      const cal = await ensureDefaultCalendar(dataId);
      const existing = await queryOne<{ id: string }>(`SELECT id FROM booking_types WHERE user_id = $1 ORDER BY created_at ASC LIMIT 1`, [dataId]);
      if (existing) return existing.id;
      const id = randomUUID();
      await query(
        `INSERT INTO booking_types (id, user_id, calendar_id, slug, name, description, duration_minutes, buffer_before, buffer_after, min_notice_minutes, max_days_ahead, price_minor, currency, active)
         VALUES ($1, $2, $3, 'intro-call', 'Intro call', 'A 30-minute introduction.', 30, 0, 10, 120, 60, NULL, NULL, TRUE)`,
        [id, dataId, cal.id]
      );
      return id;
    });
  }

  // Helpdesk: default SLA policy.
  let slaPolicyId: string | null = null;
  if (input.modules.helpdesk && (await tableExists("sla_policies"))) {
    slaPolicyId = await step("sla policy", async () => {
      const existing = await getDefaultPolicy(dataId);
      if (existing) return existing.id;
      const p = await createPolicy(dataId, { name: "Standard support", first_response_minutes: 60, resolution_minutes: 1440, business_hours_only: false, is_default: true });
      return p.id;
    });
  }

  // Starter agents (skip templates already present).
  const agentsCreated = (await step("agents", async () => {
    const existing = await query<{ template_id: string | null }>(`SELECT template_id FROM agents WHERE user_id = $1`, [dataId]);
    const have = new Set(existing.map((r) => r.template_id).filter(Boolean));
    let n = 0;
    for (const t of starterAgentsFor(input.industry)) {
      if (have.has(t.id)) continue;
      await query(
        `INSERT INTO agents (user_id, name, role, system_prompt, template_id, status, tasks_completed, tools, model, autonomy_level, max_steps)
         VALUES ($1, $2, $3, $4, $5, 'idle', 0, $6, NULL, $7, NULL)`,
        [dataId, t.name, t.role, t.system_prompt, t.id, t.tools ? JSON.stringify(t.tools) : null, input.ai.autonomy]
      ).catch(() =>
        query(
          `INSERT INTO agents (user_id, name, role, system_prompt, template_id, status, tasks_completed) VALUES ($1, $2, $3, $4, $5, 'idle', 0)`,
          [dataId, t.name, t.role, t.system_prompt, t.id]
        )
      );
      n++;
    }
    return n;
  })) ?? 0;

  // Playbooks on/off for every detector.
  if (await tableExists("playbook_settings")) {
    await step("playbooks", async () => {
      for (const p of PLAYBOOKS) {
        await query(
          `INSERT INTO playbook_settings (user_id, playbook_id, enabled, updated_at) VALUES ($1, $2, $3, NOW())
           ON CONFLICT (user_id, playbook_id) DO UPDATE SET enabled = $3, updated_at = NOW()`,
          [dataId, p.id, input.ai.playbooks]
        );
      }
    });
  }

  const completedAt = new Date().toISOString();
  const prev = await readOrgSettingsRaw(dataId);
  await mergeOrgSettings(dataId, {
    industry: input.industry,
    modules: { ...input.modules, packs: packsInstalled },
    ai_defaults: { autonomy: input.ai.autonomy, playbooks: input.ai.playbooks, outcome_pricing: input.ai.outcome_pricing },
    onboarding_completed_at: typeof prev.onboarding_completed_at === "string" ? prev.onboarding_completed_at : completedAt,
  });

  void recordAudit({ dataId, userId: actorId }, {
    action: "onboarding.completed", entity: "organization", entityId: dataId,
    after: { industry: input.industry, packs: packsInstalled, modules: input.modules, ai: input.ai, agentsCreated },
  });

  return {
    completedAt: typeof prev.onboarding_completed_at === "string" ? prev.onboarding_completed_at : completedAt,
    packsInstalled, bookingTypeId, slaPolicyId, agentsCreated, warnings,
  };
}
