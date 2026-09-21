import { randomUUID } from "crypto";
import { query, queryOne } from "@/lib/dsql";
import { enqueueJob } from "@/lib/agents/queue";
import type { PlaybookDef } from "./types";
import { stalledDeal } from "./stalled-deal";
import { unansweredInbound } from "./unanswered-inbound";
import { overdueCard } from "./overdue-card";
import { leadFollowUp } from "./lead-follow-up";
import { socialGap } from "./social-gap";

export type { PlaybookDef } from "./types";

/**
 * Proactive playbooks: "detect a situation -> spin up a dedicated agent run".
 *
 * `runPlaybookDetectors` is called by the worker/cron tick for every user;
 * `runPlaybook` is also reachable from the UI ("Run now"). Dedupe lives in
 * `playbook_runs`; per-user opt-out lives in `playbook_settings`.
 */
export const PLAYBOOKS: PlaybookDef[] = [stalledDeal, unansweredInbound, overdueCard, leadFollowUp, socialGap];

export function getPlaybook(id: string): PlaybookDef | undefined {
  return PLAYBOOKS.find((p) => p.id === id);
}

const MAX_USERS = 200;
const MAX_ENTITIES_PER_DETECT = 5;

async function isEnabled(userId: string, playbookId: string): Promise<boolean> {
  const row = await queryOne<{ enabled: boolean | null }>(
    `SELECT enabled FROM playbook_settings WHERE user_id = $1 AND playbook_id = $2`,
    [userId, playbookId]
  ).catch(() => null);
  return row ? row.enabled !== false : true;
}

async function recentlyRan(userId: string, playbookId: string, entityId: string | null, cooldownHours: number): Promise<boolean> {
  const row = await queryOne<{ id: string }>(
    `SELECT id FROM playbook_runs
     WHERE user_id = $1 AND playbook_id = $2 AND entity_id IS NOT DISTINCT FROM $3
       AND created_at > NOW() - ($4::int * INTERVAL '1 hour')
     LIMIT 1`,
    [userId, playbookId, entityId, cooldownHours]
  ).catch(() => null);
  return !!row;
}

/** Find (or create) the one agent row that fronts this playbook for a user. */
async function ensurePlaybookAgent(userId: string, pb: PlaybookDef): Promise<string> {
  const name = `Playbook: ${pb.name}`;
  const existing = await queryOne<{ id: string }>(
    `SELECT id FROM agents WHERE user_id = $1 AND name = $2 ORDER BY created_at ASC LIMIT 1`,
    [userId, name]
  ).catch(() => null);
  if (existing) return existing.id;

  const systemPrompt = [
    `You are the "${pb.name}" playbook agent. ${pb.description}`,
    "You are triggered automatically when the situation is detected. Work only on the entity named in the prompt.",
    "Be concise and concrete. Anything that sends, moves or writes will pause for a human to approve; prepare it well and explain why.",
    `Allowed tools: ${pb.defaultTools.join(", ")}.`,
  ].join("\n");

  const created = await queryOne<{ id: string }>(
    `INSERT INTO agents (user_id, name, role, system_prompt, status, tasks_completed, autonomy_level, tools)
     VALUES ($1, $2, 'Playbook Agent', $3, 'active', 0, 'approve', $4) RETURNING id`,
    [userId, name, systemPrompt, JSON.stringify(pb.defaultTools)]
  );
  if (!created) throw new Error(`could not create agent for playbook ${pb.id}`);
  return created.id;
}

type StartRunFn = (userId: string, agentId: string, opts: { prompt: string; triggerKind: string; triggerRef: string }) => Promise<string | { runId: string }>;

/** `@/lib/agents/runner` is owned by another lane; resolve it at call time and fall back to a raw enqueue. */
async function startRunCompat(args: { userId: string; agentId: string; prompt: string; triggerRef: string }): Promise<string> {
  const modulePath = "@/lib/agents/" + "runner";
  const mod = (await import(modulePath).catch(() => null)) as { startRun?: StartRunFn } | null;
  if (mod && typeof mod.startRun === "function") {
    const out = await mod.startRun(args.userId, args.agentId, {
      prompt: args.prompt,
      triggerKind: "playbook",
      triggerRef: args.triggerRef,
    });
    return typeof out === "string" ? out : out.runId;
  }
  const runId = randomUUID();
  await query(
    `INSERT INTO agent_runs (id, user_id, agent_id, status, trigger_kind, trigger_ref, prompt, output)
     VALUES ($1, $2, $3, 'queued', 'playbook', $4, $5, '')`,
    [runId, args.userId, args.agentId, args.triggerRef, args.prompt]
  );
  await enqueueJob(args.userId, { kind: "run", runId });
  return runId;
}

export async function runPlaybook(
  userId: string,
  playbookId: string,
  entityId?: string
): Promise<{ runId?: string; skipped?: string }> {
  const pb = getPlaybook(playbookId);
  if (!pb) return { skipped: "unknown playbook" };
  if (!(await isEnabled(userId, pb.id))) return { skipped: "disabled" };

  let target = entityId ?? null;
  if (!target) {
    const found = await pb.detect(userId);
    if (found.length === 0) return { skipped: "nothing to do" };
    target = found[0];
  }
  if (await recentlyRan(userId, pb.id, target, pb.cooldownHours)) return { skipped: "cooldown" };

  const agentId = await ensurePlaybookAgent(userId, pb);
  const prompt = await pb.buildPrompt(userId, target);
  const runId = await startRunCompat({ userId, agentId, prompt, triggerRef: pb.id });

  await query(
    `INSERT INTO playbook_runs (id, user_id, playbook_id, entity_id, run_id, status) VALUES ($1, $2, $3, $4, $5, 'queued')`,
    [randomUUID(), userId, pb.id, target, runId]
  ).catch((err) => console.error("[playbooks] failed to record playbook_run", err));

  return { runId };
}

/** Distinct users who have data any playbook could act on (bounded). */
async function candidateUsers(): Promise<string[]> {
  const rows = await query<{ user_id: string }>(
    `SELECT user_id FROM (
       SELECT user_id FROM crm_contacts
       UNION SELECT user_id FROM messaging_conversations
       UNION SELECT user_id FROM production_tasks
       UNION SELECT user_id FROM site_leads WHERE user_id IS NOT NULL
       UNION SELECT user_id FROM social_brands
     ) u WHERE user_id IS NOT NULL ORDER BY user_id LIMIT $1`,
    [MAX_USERS]
  ).catch(() => []);
  return rows.map((r) => r.user_id);
}

/** Cron entry point: scan every user, queue a run per detected entity (respecting cooldowns). */
export async function runPlaybookDetectors(): Promise<{ queued: number }> {
  let queued = 0;
  const users = await candidateUsers();
  for (const userId of users) {
    for (const pb of PLAYBOOKS) {
      try {
        if (!(await isEnabled(userId, pb.id))) continue;
        const entities = (await pb.detect(userId)).slice(0, MAX_ENTITIES_PER_DETECT);
        for (const entityId of entities) {
          const res = await runPlaybook(userId, pb.id, entityId);
          if (res.runId) queued++;
        }
      } catch (err) {
        console.error(`[playbooks] ${pb.id} failed for ${userId}:`, err);
      }
    }
  }
  return { queued };
}
