import { query, queryOne } from "@/lib/dsql";
import { buildBusinessDnaBlock } from "@/lib/prompts";
import type { BusinessContext } from "@/lib/strategy";
import { wrapUntrusted } from "@/lib/ai/untrusted";

/**
 * Per-module context for the copilot system prompt: a compact snapshot of the
 * user's data (counts + a few top rows) so the model can answer "what's on
 * this page" without a tool call, capped at MAX_CHARS.
 *
 * Every query is scoped by user_id and wrapped so a missing table on an older
 * deployment degrades to "no data" rather than a failed request.
 */

import { COPILOT_MODULES, type CopilotModule } from "./modules";
export { COPILOT_MODULES, type CopilotModule };

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
/** Customer/visitor-originated text: wrapped so the copilot treats it as data. */
function u(label: string, v: unknown, max = 240): string {
  return wrapUntrusted(label, v == null ? "" : String(v), { maxChars: max });
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
      if (c.notes) lines.push(`  Notes: ${u("contact_notes", c.notes, 300)}`);
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
      lines.push(`- Focused lead ${l.id} (${l.status ?? "new"}): ${u("lead_data", l.data, 300)}`);
      if (l.research_summary) lines.push(`  Research: ${u("lead_research", l.research_summary, 500)}`);
      if (l.draft_email_subject) lines.push(`  Draft subject: ${u("lead_subject", l.draft_email_subject, 100)}`);
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
  for (const r of recent) lines.push(`  - ${u("task_title", r.title, 100)} [id ${r.id}]`);
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


async function helpdeskContext(userId: string, ticketId?: string): Promise<string> {
  const byStatus = await rows<{ status: string; n: string }>(`SELECT status, COUNT(*)::int AS n FROM tickets WHERE user_id = $1 GROUP BY status`, [userId]);
  const breached = await count(`SELECT COUNT(*)::int AS n FROM tickets WHERE user_id = $1 AND status IN ('open','pending') AND (breached_first_response OR breached_resolution)`, [userId]);
  const lines = [`## Helpdesk snapshot`, `- Tickets: ${byStatus.map((r) => `${r.status} ${r.n}`).join(", ") || "none"}; ${breached} active ticket(s) past an SLA target`];
  const urgent = await rows(
    `SELECT id, number, subject, status, priority, first_response_due_at, requester_email FROM tickets WHERE user_id = $1 AND status IN ('open','pending')
     ORDER BY CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, created_at ASC LIMIT 8`,
    [userId]
  );
  for (const t of urgent) lines.push(`  - #${t.number} ${u("ticket_subject", t.subject, 60)} — ${t.status}, ${t.priority}${t.first_response_due_at ? `, first response due ${String(t.first_response_due_at).slice(0, 16)}` : ""} [id ${t.id}]`);
  if (ticketId) {
    const t = await queryOne<Row>(`SELECT id, number, subject, status, priority, requester_name, requester_email, assigned_to, first_response_due_at, resolution_due_at, breached_first_response, breached_resolution, tags FROM tickets WHERE id = $1 AND user_id = $2`, [ticketId, userId]).catch(() => null);
    if (t) {
      lines.push(`- Focused ticket #${t.number} ${u("ticket_subject", t.subject, 80)}: ${t.status}, ${t.priority}, requester ${u("ticket_requester", `${t.requester_name ?? ""} <${t.requester_email ?? ""}>`, 100)}${t.assigned_to ? `, assigned to ${t.assigned_to}` : ", unassigned"}${t.breached_first_response || t.breached_resolution ? " — SLA BREACHED" : ""}`);
      const msgs = await rows(`SELECT author_kind, is_internal, LEFT(body, 240) AS body, created_at FROM ticket_messages WHERE ticket_id = $1 AND user_id = $2 ORDER BY created_at DESC LIMIT 5`, [ticketId, userId]);
      for (const m of msgs.reverse()) lines.push(`  - ${day(m.created_at)} ${m.author_kind}${m.is_internal ? " (internal)" : ""}: ${m.is_internal ? s(m.body, 240) : u("ticket_message", m.body, 240)}`);
    }
  }
  return lines.join("\n");
}

async function knowledgeContext(userId: string): Promise<string> {
  const byStatus = await rows<{ status: string; n: string }>(`SELECT status, COUNT(*)::int AS n FROM kb_articles WHERE user_id = $1 GROUP BY status`, [userId]);
  const lines = [`## Knowledge base snapshot`, `- Articles: ${byStatus.map((r) => `${r.status} ${r.n}`).join(", ") || "none"}`];
  const recent = await rows(`SELECT id, slug, title, status, category, views, updated_at FROM kb_articles WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 8`, [userId]);
  for (const a of recent) lines.push(`  - ${s(a.title, 60)} (${a.status}${a.category ? `, ${a.category}` : ""}, ${a.views} views) [id ${a.id}]`);
  return lines.join("\n");
}

async function inventoryContext(userId: string, productId?: string): Promise<string> {
  const total = await count(`SELECT COUNT(*)::int AS n FROM products WHERE user_id = $1 AND deleted_at IS NULL`, [userId]);
  const low = await rows(`SELECT id, name, sku, stock_on_hand, stock_reserved, reorder_point FROM products WHERE user_id = $1 AND deleted_at IS NULL AND track_stock AND (stock_on_hand - stock_reserved) <= reorder_point ORDER BY (stock_on_hand - stock_reserved) ASC LIMIT 8`, [userId]);
  const out = await count(`SELECT COUNT(*)::int AS n FROM equipment_checkouts WHERE user_id = $1 AND returned_at IS NULL`, [userId]);
  const overdue = await count(`SELECT COUNT(*)::int AS n FROM equipment_checkouts WHERE user_id = $1 AND returned_at IS NULL AND due_back_at < NOW()`, [userId]);
  const lines = [`## Inventory snapshot`, `- ${total} products; ${low.length} at/below reorder point; ${out} equipment checkout(s) open, ${overdue} overdue`];
  for (const p of low) lines.push(`  - LOW ${s(p.name, 50)}${p.sku ? ` (${p.sku})` : ""}: ${Number(p.stock_on_hand) - Number(p.stock_reserved)} available, reorder at ${p.reorder_point} [id ${p.id}]`);
  if (productId) {
    const p = await queryOne<Row>(`SELECT id, name, sku, kind, unit_price_minor AS price_minor, cost_minor, currency, stock_on_hand, stock_reserved, reorder_point, track_stock FROM products WHERE id = $1 AND user_id = $2`, [productId, userId]).catch(() => null);
    if (p) lines.push(`- Focused product ${s(p.name, 60)} (${p.kind}): price ${p.price_minor} ${p.currency}, cost ${p.cost_minor ?? "-"}, ${p.track_stock ? `${p.stock_on_hand} on hand / ${p.stock_reserved} reserved` : "stock not tracked"} [id ${p.id}]`);
  }
  return lines.join("\n");
}

async function financeContext(userId: string): Promise<string> {
  const exp = await queryOne<{ n: string; total: string }>(`SELECT COUNT(*)::int AS n, COALESCE(SUM(amount_minor + tax_minor),0)::bigint AS total FROM expenses WHERE user_id = $1 AND spent_at >= date_trunc('month', NOW())`, [userId]).catch(() => null);
  const unbilled = await count(`SELECT COUNT(*)::int AS n FROM expenses WHERE user_id = $1 AND billable AND invoice_id IS NULL`, [userId]);
  const running = await rows(`SELECT id, description, started_at, ref_kind, ref_id FROM time_entries WHERE user_id = $1 AND ended_at IS NULL ORDER BY started_at DESC LIMIT 5`, [userId]);
  const cos = await rows<{ status: string; n: string }>(`SELECT status, COUNT(*)::int AS n FROM change_orders WHERE user_id = $1 GROUP BY status`, [userId]);
  const lines = [
    `## Finance snapshot`,
    `- This month: ${exp?.n ?? 0} expense(s) totalling ${exp?.total ?? 0} minor units; ${unbilled} billable expense(s) not yet invoiced`,
    `- Running timers: ${running.length}${running.length ? ` — ${running.map((r) => `${s(r.description, 40) || "(untitled)"} since ${String(r.started_at).slice(0, 16)} [id ${r.id}]`).join("; ")}` : ""}`,
    `- Change orders: ${cos.map((r) => `${r.status} ${r.n}`).join(", ") || "none"}`,
  ];
  return lines.join("\n");
}

async function billingContext(userId: string): Promise<string> {
  const q = await rows<{ status: string; n: string; total: string }>(`SELECT status, COUNT(*)::int AS n, COALESCE(SUM(total_minor),0)::bigint AS total FROM quotes WHERE user_id = $1 GROUP BY status`, [userId]);
  const inv = await rows<{ status: string; n: string; total: string }>(`SELECT status, COUNT(*)::int AS n, COALESCE(SUM(total_minor),0)::bigint AS total FROM invoices WHERE user_id = $1 GROUP BY status`, [userId]);
  const lines = [
    `## Billing snapshot`,
    `- Quotes: ${q.map((r) => `${r.status} ${r.n} (${r.total})`).join(", ") || "none"}`,
    `- Invoices: ${inv.map((r) => `${r.status} ${r.n} (${r.total})`).join(", ") || "none"}`,
  ];
  const overdue = await rows(`SELECT id, number, total_minor, currency, due_at FROM invoices WHERE user_id = $1 AND status IN ('sent','overdue','partially_paid') AND due_at < NOW() ORDER BY due_at ASC LIMIT 6`, [userId]);
  for (const r of overdue) lines.push(`  - OVERDUE ${r.number}: ${r.total_minor} ${r.currency}, due ${day(r.due_at)} [id ${r.id}]`);
  return lines.join("\n");
}

async function calendarContext(userId: string): Promise<string> {
  const upcoming = await rows(`SELECT id, name, starts_at, ends_at, status FROM bookings WHERE user_id = $1 AND status <> 'cancelled' AND starts_at >= NOW() ORDER BY starts_at ASC LIMIT 8`, [userId]);
  const types = await rows(`SELECT id, slug, name, duration_minutes FROM booking_types WHERE user_id = $1 AND active = TRUE LIMIT 10`, [userId]);
  const lines = [`## Calendar snapshot`, `- Booking types: ${types.map((t) => `${t.name} (${t.slug}, ${t.duration_minutes}m)`).join(", ") || "none"}`, `- Upcoming: ${upcoming.length}`];
  for (const b of upcoming) lines.push(`  - ${String(b.starts_at).slice(0, 16)} ${u("booking_name", b.name, 60)} (${b.status}) [id ${b.id}]`);
  return lines.join("\n");
}

async function recordsContext(userId: string, typeSlug?: string | null, recordId?: string): Promise<string> {
  const types = await rows(`SELECT id, slug, name FROM record_types WHERE user_id = $1 ORDER BY name LIMIT 20`, [userId]);
  const lines = [`## Records snapshot`, `- Types: ${types.map((t) => `${t.name} (${t.slug})`).join(", ") || "none"}`];
  const focus = typeSlug ? types.find((t) => t.slug === typeSlug || t.id === typeSlug) : undefined;
  if (focus) {
    const stages = await rows<{ stage: string; n: string }>(`SELECT stage, COUNT(*)::int AS n FROM records WHERE user_id = $1 AND type_id = $2 AND deleted_at IS NULL GROUP BY stage`, [userId, focus.id]);
    lines.push(`- ${focus.name}: ${stages.map((r) => `${r.stage} ${r.n}`).join(", ") || "no records"}`);
    const recent = await rows(`SELECT id, title, stage, updated_at FROM records WHERE user_id = $1 AND type_id = $2 AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 8`, [userId, focus.id]);
    for (const r of recent) lines.push(`  - ${s(r.title, 60)} — ${r.stage} [id ${r.id}]`);
  }
  if (recordId) {
    const r = await queryOne<Row>(`SELECT id, title, stage, summary, data, due_at, amount_minor, currency FROM records WHERE id = $1 AND user_id = $2`, [recordId, userId]).catch(() => null);
    if (r) lines.push(`- Focused record "${s(r.title, 80)}" (${r.stage})${r.amount_minor ? `, ${r.amount_minor} ${r.currency ?? ""}` : ""}${r.due_at ? `, due ${day(r.due_at)}` : ""}: ${s(r.summary ?? r.data, 400)}`);
  }
  return lines.join("\n");
}

async function reportsContext(userId: string): Promise<string> {
  const paid = await queryOne<{ n: string; total: string }>(`SELECT COUNT(*)::int AS n, COALESCE(SUM(total_minor),0)::bigint AS total FROM invoices WHERE user_id = $1 AND status = 'paid' AND updated_at >= NOW() - INTERVAL '30 days'`, [userId]).catch(() => null);
  const quotes = await count(`SELECT COUNT(*)::int AS n FROM quotes WHERE user_id = $1 AND status IN ('sent','draft')`, [userId]);
  const tickets = await count(`SELECT COUNT(*)::int AS n FROM tickets WHERE user_id = $1 AND status IN ('open','pending')`, [userId]);
  return [`## Reports snapshot (last 30 days)`, `- ${paid?.n ?? 0} paid invoice(s) totalling ${paid?.total ?? 0} minor units; ${quotes} open quote(s); ${tickets} open ticket(s)`, `- Use optimize.* and reports.job_costing for computed figures.`].join("\n");
}

async function marketplaceContext(userId: string): Promise<string> {
  const installs = await rows(`SELECT listing_id, MAX(version) AS version, MAX(created_at) AS at FROM marketplace_installs WHERE user_id = $1 GROUP BY listing_id ORDER BY at DESC LIMIT 10`, [userId]);
  const mine = await count(`SELECT COUNT(*)::int AS n FROM marketplace_listings WHERE user_id = $1`, [userId]);
  return [`## Marketplace snapshot`, `- ${installs.length} installed listing(s)${installs.length ? `: ${installs.map((i) => `${i.listing_id} v${i.version}`).join(", ")}` : ""}; ${mine} published by this workspace`].join("\n");
}

async function voiceContext(userId: string, campaignId?: string): Promise<string> {
  const camps = await rows(`SELECT id, name, status, timezone, window_start, window_end FROM voice_campaigns WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 8`, [userId]);
  const dnc = await count(`SELECT COUNT(*)::int AS n FROM contact_optouts WHERE user_id = $1`, [userId]);
  const lines = [`## Voice snapshot`, `- ${camps.length} campaign(s); ${dnc} number(s) on do-not-call`];
  for (const c of camps) lines.push(`  - ${s(c.name, 50)} — ${c.status}, ${c.window_start}–${c.window_end} ${c.timezone} [id ${c.id}]`);
  if (campaignId) {
    const t = await rows<{ status: string; n: string }>(`SELECT status, COUNT(*)::int AS n FROM voice_campaign_targets WHERE campaign_id = $1 AND user_id = $2 GROUP BY status`, [campaignId, userId]);
    lines.push(`- Focused campaign targets: ${t.map((r) => `${r.status} ${r.n}`).join(", ") || "none"}`);
  }
  return lines.join("\n");
}

async function settingsContext(userId: string): Promise<string> {
  const [members, keys, webhooks, credits] = await Promise.all([
    count(`SELECT COUNT(*)::int AS n FROM memberships m JOIN organizations o ON o.id = m.org_id WHERE o.owner_user_id = $1 AND m.status = 'active'`, [userId]),
    count(`SELECT COUNT(*)::int AS n FROM api_keys WHERE user_id = $1 AND revoked_at IS NULL`, [userId]),
    count(`SELECT COUNT(*)::int AS n FROM webhook_subscriptions WHERE user_id = $1 AND active`, [userId]),
    queryOne<{ balance: string }>(`SELECT balance FROM ai_credit_accounts WHERE user_id = $1`, [userId]).catch(() => null),
  ]);
  return [`## Settings snapshot`, `- ${members} active member(s), ${keys} API key(s), ${webhooks} active webhook(s), credit balance ${credits?.balance ?? "n/a"}`].join("\n");
}

async function homeContext(userId: string): Promise<string> {
  const base = await generalContext(userId);
  const [overdueInv, breached, dueToday] = await Promise.all([
    count(`SELECT COUNT(*)::int AS n FROM invoices WHERE user_id = $1 AND status IN ('sent','overdue','partially_paid') AND due_at < NOW()`, [userId]),
    count(`SELECT COUNT(*)::int AS n FROM tickets WHERE user_id = $1 AND status IN ('open','pending') AND (breached_first_response OR breached_resolution)`, [userId]),
    count(`SELECT COUNT(*)::int AS n FROM bookings WHERE user_id = $1 AND status <> 'cancelled' AND starts_at::date = CURRENT_DATE`, [userId]),
  ]);
  return `${base}\n- Needs you: ${overdueInv} overdue invoice(s), ${breached} SLA breach(es), ${dueToday} booking(s) today. Call home.summary for the full picture.`;
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
export interface ModuleContextOptions {
  /** Entity ids from the page, keyed by param name (ticket, product, campaign, record…). */
  params?: Record<string, string>;
  /** Record type slug when on /r/<type>. */
  recordType?: string | null;
}

export async function buildModuleContext(userId: string, module: CopilotModule, recordId?: string, opts: ModuleContextOptions = {}): Promise<string> {
  const id = recordId?.trim() || undefined;
  const p = opts.params ?? {};
  let body: string;
  try {
    switch (module) {
      case "helpdesk":
        body = await helpdeskContext(userId, p.ticket ?? id);
        break;
      case "knowledge":
        body = await knowledgeContext(userId);
        break;
      case "inventory":
        body = await inventoryContext(userId, p.product ?? id);
        break;
      case "finance":
        body = await financeContext(userId);
        break;
      case "billing":
        body = await billingContext(userId);
        break;
      case "calendar":
        body = await calendarContext(userId);
        break;
      case "records":
        body = await recordsContext(userId, opts.recordType, p.record ?? id);
        break;
      case "reports":
        body = await reportsContext(userId);
        break;
      case "insights":
        body = await reportsContext(userId);
        break;
      case "marketplace":
        body = await marketplaceContext(userId);
        break;
      case "voice":
        body = await voiceContext(userId, p.campaign ?? id);
        break;
      case "settings":
        body = await settingsContext(userId);
        break;
      case "home":
        body = await homeContext(userId);
        break;
      case "crm":
        body = await crmContext(userId, p.contact ?? p.id ?? id);
        break;
      case "leads":
        body = await leadsContext(userId, p.lead ?? p.id ?? id);
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
        body = await agentsContext(userId, p.agent ?? p.id ?? id);
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
