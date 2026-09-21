import { query, queryOne } from "@/lib/dsql";
import { buildBusinessDnaBlock } from "@/lib/prompts";
import type { BusinessContext } from "@/lib/strategy";

/**
 * Per-module context for the copilot system prompt: a compact snapshot of the
 * user's data (counts + a few top rows) so the model can answer "what's on
 * this page" without a tool call, capped at MAX_CHARS.
 *
 * Every query is scoped by user_id and wrapped so a missing table on an older
 * deployment degrades to "no data" rather than a failed request.
 */

export const COPILOT_MODULES = ["crm", "leads", "production", "social", "strategy", "tasks", "ads", "agents", "general"] as const;
export type CopilotModule = (typeof COPILOT_MODULES)[number];

const MAX_CHARS = 2500;

type Row = Record<string, unknown>;

async function rows<T extends Row = Row>(sql: string, params: unknown[]): Promise<T[]> {
  return query<T>(sql, params).catch(() => []);
}
async function count(sql: string, params: unknown[]): Promise<number> {
  const r = await queryOne<{ n: string | number }>(sql, params).catch(() => null);
  return Number(r?.n ?? 0) || 0;
}
function s(v: unknown, max = 80): string {
  const str = v == null ? "" : String(v);
  return str.length > max ? `${str.slice(0, max - 1)}…` : str;
}
function day(v: unknown): string {
  const str = v == null ? "" : String(v);
  return str.slice(0, 10);
}
function cap(text: string): string {
  return text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS - 12)}\n[truncated]` : text;
}

async function crmContext(userId: string, recordId?: string): Promise<string> {
  const stages = await rows<{ lifecycle: string; n: string }>(
    `SELECT lifecycle, COUNT(*)::int AS n FROM crm_contacts WHERE user_id = $1 GROUP BY lifecycle ORDER BY n DESC`,
    [userId]
  );
  const total = stages.reduce((a, r) => a + Number(r.n), 0);
  const lines = [`## CRM snapshot`, `- ${total} contacts: ${stages.map((r) => `${r.lifecycle} ${r.n}`).join(", ") || "none"}`];
  const recent = await rows(
    `SELECT id, full_name, company, lifecycle, deal_value, updated_at FROM crm_contacts WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 8`,
    [userId]
  );
  if (recent.length) {
    lines.push("- Recently updated:");
    for (const r of recent) lines.push(`  - ${s(r.full_name, 40)}${r.company ? ` (${s(r.company, 30)})` : ""} — ${r.lifecycle}, $${r.deal_value ?? 0} [id ${r.id}]`);
  }
  if (recordId) {
    const c = await queryOne<Row>(
      `SELECT id, full_name, email, company, role, lifecycle, deal_value, notes, last_contact FROM crm_contacts WHERE id = $1 AND user_id = $2`,
      [recordId, userId]
    ).catch(() => null);
    if (c) {
      lines.push(`- Focused contact: ${s(c.full_name, 60)} <${s(c.email, 60)}> at ${s(c.company, 40)}, ${c.role ?? "-"}, stage ${c.lifecycle}, deal $${c.deal_value ?? 0}, last contact ${day(c.last_contact) || "never"}`);
      if (c.notes) lines.push(`  Notes: ${s(c.notes, 300)}`);
      const acts = await rows(
        `SELECT type, title, created_at FROM crm_activities WHERE contact_id = $1 AND user_id = $2 ORDER BY created_at DESC LIMIT 5`,
        [recordId, userId]
      );
      for (const a of acts) lines.push(`  - ${day(a.created_at)} ${a.type}: ${s(a.title, 80)}`);
    }
  }
  return lines.join("\n");
}

async function leadsContext(userId: string, recordId?: string): Promise<string> {
  const byStatus = await rows<{ status: string; n: string }>(
    `SELECT COALESCE(status,'new') AS status, COUNT(*)::int AS n FROM site_leads WHERE user_id = $1 GROUP BY 1 ORDER BY n DESC`,
    [userId]
  );
  const total = byStatus.reduce((a, r) => a + Number(r.n), 0);
  const lines = [`## Leads snapshot`, `- ${total} leads: ${byStatus.map((r) => `${r.status} ${r.n}`).join(", ") || "none"}`];
  const recent = await rows(
    `SELECT id, data, status, created_at, enriched_at FROM site_leads WHERE user_id = $1 ORDER BY created_at DESC LIMIT 6`,
    [userId]
  );
  for (const r of recent) {
    let who = "";
    try {
      const d = JSON.parse(String(r.data ?? "{}")) as Row;
      who = [d.name, d.email, d.company].filter(Boolean).map((v) => s(v, 40)).join(" / ");
    } catch {
      who = "";
    }
    lines.push(`  - ${day(r.created_at)} ${who || "(no details)"} — ${r.status ?? "new"}${r.enriched_at ? ", enriched" : ""} [id ${r.id}]`);
  }
  if (recordId) {
    const l = await queryOne<Row>(
      `SELECT id, data, status, research_summary, draft_email_subject FROM site_leads WHERE id = $1 AND user_id = $2`,
      [recordId, userId]
    ).catch(() => null);
    if (l) {
      lines.push(`- Focused lead ${l.id} (${l.status ?? "new"}): ${s(l.data, 300)}`);
      if (l.research_summary) lines.push(`  Research: ${s(l.research_summary, 500)}`);
      if (l.draft_email_subject) lines.push(`  Draft subject: ${s(l.draft_email_subject, 100)}`);
    }
  }
  return lines.join("\n");
}

async function productionContext(userId: string, recordId?: string): Promise<string> {
  const cfg = await queryOne<{ columns: string }>(`SELECT columns FROM board_configs WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`, [userId]).catch(
    () => null
  );
  let cols: { id: string; label: string; hitl?: boolean }[] = [];
  try {
    const parsed: unknown = JSON.parse(cfg?.columns ?? "[]");
    if (Array.isArray(parsed)) cols = parsed as { id: string; label: string; hitl?: boolean }[];
  } catch {
    cols = [];
  }
  const byStatus = await rows<{ status: string; n: string }>(
    `SELECT status, COUNT(*)::int AS n FROM production_tasks WHERE user_id = $1 GROUP BY status`,
    [userId]
  );
  const label = (id: string) => cols.find((c) => c.id === id)?.label ?? id;
  const lines = [
    `## Production board snapshot`,
    `- Columns: ${cols.map((c) => `${c.label} (id ${c.id}${c.hitl ? ", needs approval" : ""})`).join(", ") || "default"}`,
    `- Cards per column: ${byStatus.map((r) => `${label(r.status)} ${r.n}`).join(", ") || "none"}`,
  ];
  const recent = await rows(
    `SELECT id, title, status, priority, due_date FROM production_tasks WHERE user_id = $1 ORDER BY created_at DESC LIMIT 8`,
    [userId]
  );
  for (const r of recent) lines.push(`  - ${s(r.title, 60)} — ${label(String(r.status))}, ${r.priority}${r.due_date ? `, due ${day(r.due_date)}` : ""} [id ${r.id}]`);
  if (recordId) {
    const c = await queryOne<Row>(`SELECT id, title, status, priority, description, due_date, assignee FROM production_tasks WHERE id = $1 AND user_id = $2`, [
      recordId,
      userId,
    ]).catch(() => null);
    if (c) lines.push(`- Focused card: ${s(c.title, 80)} in ${label(String(c.status))}, ${c.priority}${c.assignee ? `, assignee ${s(c.assignee, 40)}` : ""}. ${s(c.description, 400)}`);
  }
  return lines.join("\n");
}

async function socialContext(userId: string, recordId?: string): Promise<string> {
  const byStatus = await rows<{ status: string; n: string }>(`SELECT status, COUNT(*)::int AS n FROM social_posts WHERE user_id = $1 GROUP BY status`, [userId]);
  const lines = [`## Social snapshot`, `- Posts: ${byStatus.map((r) => `${r.status} ${r.n}`).join(", ") || "none"}`];
  const upcoming = await rows(
    `SELECT id, platform, caption, scheduled_at, status FROM social_posts WHERE user_id = $1 AND status IN ('scheduled','draft') ORDER BY COALESCE(scheduled_at, created_at) ASC LIMIT 6`,
    [userId]
  );
  if (upcoming.length) lines.push("- Upcoming / drafts:");
  for (const r of upcoming) lines.push(`  - ${r.platform} ${r.status}${r.scheduled_at ? ` @ ${String(r.scheduled_at).slice(0, 16)}` : ""}: ${s(r.caption, 70)} [id ${r.id}]`);
  const failed = await rows(`SELECT id, platform, publish_error FROM social_posts WHERE user_id = $1 AND status = 'failed' ORDER BY updated_at DESC LIMIT 3`, [userId]);
  for (const r of failed) lines.push(`  - FAILED ${r.platform}: ${s(r.publish_error, 100)} [id ${r.id}]`);
  if (recordId) {
    const p = await queryOne<Row>(`SELECT id, platform, caption, hashtags, status, scheduled_at FROM social_posts WHERE id = $1 AND user_id = $2`, [recordId, userId]).catch(
      () => null
    );
    if (p) lines.push(`- Focused post ${p.id} (${p.platform}, ${p.status}): ${s(p.caption, 400)} ${s(p.hashtags, 120)}`);
  }
  return lines.join("\n");
}

async function strategyContext(userId: string, recordId?: string): Promise<string> {
  const n = await count(`SELECT COUNT(*)::int AS n FROM strategies WHERE user_id = $1`, [userId]);
  const lines = [`## Strategy snapshot`, `- ${n} saved strategy document(s)`];
  const recent = await rows(`SELECT id, title, type, status, created_at FROM strategies WHERE user_id = $1 ORDER BY created_at DESC LIMIT 8`, [userId]);
  for (const r of recent) lines.push(`  - ${day(r.created_at)} ${s(r.title, 60)} (${r.type}, ${r.status}) [id ${r.id}]`);
  if (recordId) {
    const d = await queryOne<Row>(`SELECT title, type, LEFT(content, 1200) AS excerpt FROM strategies WHERE id = $1 AND user_id = $2`, [recordId, userId]).catch(() => null);
    if (d) lines.push(`- Focused strategy "${s(d.title, 80)}" (${d.type}):\n${s(d.excerpt, 1200)}`);
  }
  return lines.join("\n");
}

async function tasksContext(userId: string): Promise<string> {
  const open = await count(`SELECT COUNT(*)::int AS n FROM tasks WHERE user_id = $1 AND done = FALSE`, [userId]);
  const done = await count(`SELECT COUNT(*)::int AS n FROM tasks WHERE user_id = $1 AND done = TRUE`, [userId]);
  const lines = [`## Tasks snapshot`, `- ${open} open, ${done} done`];
  const recent = await rows(`SELECT id, title, created_at FROM tasks WHERE user_id = $1 AND done = FALSE ORDER BY created_at DESC LIMIT 10`, [userId]);
  for (const r of recent) lines.push(`  - ${s(r.title, 80)} [id ${r.id}]`);
  return lines.join("\n");
}

async function adsContext(userId: string): Promise<string> {
  const accounts = await rows(`SELECT platform, account_name, connected, last_synced_at, last_sync_error FROM ad_accounts WHERE user_id = $1 LIMIT 10`, [userId]);
  const lines = [`## Ads snapshot`, `- ${accounts.length} ad account(s): ${accounts.map((a) => `${a.platform}${a.account_name ? ` ${s(a.account_name, 30)}` : ""}${a.connected ? "" : " (disconnected)"}`).join(", ") || "none"}`];
  const totals = await rows<{ platform: string; spend: number; clicks: number; impressions: number; conversions: number }>(
    `SELECT platform, SUM(spend)::float AS spend, SUM(clicks)::bigint AS clicks, SUM(impressions)::bigint AS impressions, SUM(conversions)::float AS conversions
     FROM ad_stats WHERE user_id = $1 AND stat_date >= CURRENT_DATE - INTERVAL '30 days' GROUP BY platform`,
    [userId]
  );
  if (totals.length) lines.push("- Last 30 days:");
  for (const t of totals) lines.push(`  - ${t.platform}: spend $${Number(t.spend).toFixed(2)}, ${t.impressions} impressions, ${t.clicks} clicks, ${Number(t.conversions).toFixed(0)} conversions`);
  const top = await rows(
    `SELECT campaign_name, SUM(spend)::float AS spend, SUM(conversions)::float AS conv FROM ad_stats
     WHERE user_id = $1 AND stat_date >= CURRENT_DATE - INTERVAL '30 days' AND campaign_name IS NOT NULL GROUP BY campaign_name ORDER BY spend DESC LIMIT 5`,
    [userId]
  );
  for (const c of top) lines.push(`  - Campaign ${s(c.campaign_name, 50)}: $${Number(c.spend).toFixed(2)} spend, ${Number(c.conv).toFixed(0)} conversions`);
  return lines.join("\n");
}

async function agentsContext(userId: string, recordId?: string): Promise<string> {
  const agents = await rows(`SELECT id, name, role, status, autonomy_level FROM agents WHERE user_id = $1 ORDER BY created_at DESC LIMIT 10`, [userId]);
  const lines = [`## Agents snapshot`, `- ${agents.length} agent(s)`];
  for (const a of agents) lines.push(`  - ${s(a.name, 40)} — ${s(a.role, 40)}, ${a.status}, autonomy ${a.autonomy_level ?? "approve"} [id ${a.id}]`);
  const runs = await rows(
    `SELECT r.id, a.name AS agent, r.status, r.created_at FROM agent_runs r LEFT JOIN agents a ON a.id = r.agent_id
     WHERE r.user_id = $1 ${recordId ? "AND r.agent_id = $2" : ""} ORDER BY r.created_at DESC LIMIT 6`,
    recordId ? [userId, recordId] : [userId]
  );
  if (runs.length) lines.push("- Recent runs:");
  for (const r of runs) lines.push(`  - ${day(r.created_at)} ${s(r.agent, 30)} — ${r.status ?? "done"} [run ${r.id}]`);
  const pending = await count(`SELECT COUNT(*)::int AS n FROM approvals WHERE user_id = $1 AND status = 'pending'`, [userId]);
  lines.push(`- ${pending} approval(s) pending`);
  return lines.join("\n");
}

async function generalContext(userId: string): Promise<string> {
  const [contacts, leads, cards, openTasks, scheduled, pending] = await Promise.all([
    count(`SELECT COUNT(*)::int AS n FROM crm_contacts WHERE user_id = $1`, [userId]),
    count(`SELECT COUNT(*)::int AS n FROM site_leads WHERE user_id = $1 AND COALESCE(status,'new') = 'new'`, [userId]),
    count(`SELECT COUNT(*)::int AS n FROM production_tasks WHERE user_id = $1 AND status <> 'done'`, [userId]),
    count(`SELECT COUNT(*)::int AS n FROM tasks WHERE user_id = $1 AND done = FALSE`, [userId]),
    count(`SELECT COUNT(*)::int AS n FROM social_posts WHERE user_id = $1 AND status = 'scheduled'`, [userId]),
    count(`SELECT COUNT(*)::int AS n FROM approvals WHERE user_id = $1 AND status = 'pending'`, [userId]),
  ]);
  return [
    `## Workspace snapshot`,
    `- ${contacts} CRM contacts, ${leads} new leads, ${cards} open production cards, ${openTasks} open tasks, ${scheduled} scheduled posts, ${pending} pending approvals`,
  ].join("\n");
}

/** Business DNA block (empty string when onboarding is incomplete). */
export async function buildDnaContext(userId: string): Promise<string> {
  const profile = await queryOne<Partial<BusinessContext>>(
    `SELECT company_name, industry, stage, geography, product_desc, target_market, challenge, revenue_range FROM business_profile WHERE user_id = $1`,
    [userId]
  ).catch(() => null);
  return buildBusinessDnaBlock(profile ?? null);
}

/**
 * System-prompt block for one module. Always includes the Business DNA
 * block when available; module data is capped at MAX_CHARS.
 */
export async function buildModuleContext(userId: string, module: CopilotModule, recordId?: string): Promise<string> {
  const id = recordId?.trim() || undefined;
  let body: string;
  try {
    switch (module) {
      case "crm":
        body = await crmContext(userId, id);
        break;
      case "leads":
        body = await leadsContext(userId, id);
        break;
      case "production":
        body = await productionContext(userId, id);
        break;
      case "social":
        body = await socialContext(userId, id);
        break;
      case "strategy":
        body = await strategyContext(userId, id);
        break;
      case "tasks":
        body = await tasksContext(userId);
        break;
      case "ads":
        body = await adsContext(userId);
        break;
      case "agents":
        body = await agentsContext(userId, id);
        break;
      default:
        body = await generalContext(userId);
    }
  } catch (err) {
    console.error(`[copilot] context for ${module} failed:`, err);
    body = `## ${module} snapshot\n- (unavailable)`;
  }
  const dna = await buildDnaContext(userId);
  return [dna, cap(body)].filter(Boolean).join("\n\n");
}
