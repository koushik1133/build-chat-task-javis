import { NextResponse } from "next/server";
import { requireUser } from "@/lib/supabase/server";
import { query, queryOne } from "@/lib/dsql";

type DayCount = { day: string; count: number };

function last7Days(): string[] {
  const days: string[] = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    days.push(d.toISOString().slice(0, 10));
  }
  return days;
}

function fillWeek(rows: DayCount[]): number[] {
  const map = new Map(rows.map(r => [r.day?.slice(0, 10), Number(r.count)]));
  return last7Days().map(d => map.get(d) ?? 0);
}

export async function GET() {
  let user;
  try { ({ user } = await requireUser()); }
  catch { return NextResponse.json({ error: "unauthorized" }, { status: 401 }); }

  const uid = user.id;

  try {
  const [
    leadsRow,
    sitesRow,
    agentsRow,
    productionRow,
    productionDoneRow,
    strategiesRow,
    automationsRow,
    agentRunsRow,
    chatTasksRow,
    weeklyLeads,
    weeklyProduction,
    weeklyAgentRuns,
    recentActivity,
  ] = await Promise.all([
    queryOne<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM site_leads sl
       JOIN sites s ON s.id = sl.site_id WHERE s.user_id = $1`,
      [uid]
    ).catch(() => ({ count: "0" })),
    queryOne<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM sites WHERE user_id = $1`,
      [uid]
    ).catch(() => ({ count: "0" })),
    queryOne<{ total: string; active: string }>(
      `SELECT COUNT(*)::text AS total,
              COUNT(*) FILTER (WHERE status = 'active')::text AS active
       FROM agents WHERE user_id = $1`,
      [uid]
    ).catch(() => ({ total: "0", active: "0" })),
    queryOne<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM production_tasks WHERE user_id = $1`,
      [uid]
    ).catch(() => ({ count: "0" })),
    queryOne<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM production_tasks
       WHERE user_id = $1 AND status IN ('done', 'delivered', 'won')`,
      [uid]
    ).catch(() => ({ count: "0" })),
    queryOne<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM strategies WHERE user_id = $1`,
      [uid]
    ).catch(() => ({ count: "0" })),
    queryOne<{ count: string; runs: string }>(
      `SELECT COUNT(*)::text AS count, COALESCE(SUM(run_count), 0)::text AS runs
       FROM automations WHERE user_id = $1`,
      [uid]
    ).catch(() => ({ count: "0", runs: "0" })),
    queryOne<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM agent_runs WHERE user_id = $1`,
      [uid]
    ).catch(() => ({ count: "0" })),
    queryOne<{ count: string; done: string }>(
      `SELECT COUNT(*)::text AS count,
              COUNT(*) FILTER (WHERE done = true)::text AS done
       FROM tasks WHERE user_id = $1`,
      [uid]
    ).catch(() => ({ count: "0", done: "0" })),
    query<DayCount>(
      `SELECT DATE(sl.created_at)::text AS day, COUNT(*)::int AS count
       FROM site_leads sl JOIN sites s ON s.id = sl.site_id
       WHERE s.user_id = $1 AND sl.created_at >= NOW() - INTERVAL '7 days'
       GROUP BY DATE(sl.created_at) ORDER BY day`,
      [uid]
    ).catch(() => []),
    query<DayCount>(
      `SELECT DATE(created_at)::text AS day, COUNT(*)::int AS count
       FROM production_tasks
       WHERE user_id = $1 AND created_at >= NOW() - INTERVAL '7 days'
       GROUP BY DATE(created_at) ORDER BY day`,
      [uid]
    ).catch(() => []),
    query<DayCount>(
      `SELECT DATE(created_at)::text AS day, COUNT(*)::int AS count
       FROM agent_runs
       WHERE user_id = $1 AND created_at >= NOW() - INTERVAL '7 days'
       GROUP BY DATE(created_at) ORDER BY day`,
      [uid]
    ).catch(() => []),
    query(
      `SELECT 'production' AS kind, title AS label, created_at FROM production_tasks WHERE user_id = $1
       UNION ALL
       SELECT 'strategy', title, created_at FROM strategies WHERE user_id = $1
       UNION ALL
       SELECT 'agent_run', COALESCE(workflow_name, 'Agent run'), created_at FROM agent_runs WHERE user_id = $1
       ORDER BY created_at DESC LIMIT 8`,
      [uid]
    ).catch(() => []),
  ]);

  const totalLeads = parseInt(leadsRow?.count ?? "0", 10);
  const totalSites = parseInt(sitesRow?.count ?? "0", 10);
  const activeAgents = parseInt(agentsRow?.active ?? "0", 10);
  const totalAgents = parseInt(agentsRow?.total ?? "0", 10);
  const productionTasks = parseInt(productionRow?.count ?? "0", 10);
  const productionDone = parseInt(productionDoneRow?.count ?? "0", 10);
  const strategies = parseInt(strategiesRow?.count ?? "0", 10);
  const automations = parseInt(automationsRow?.count ?? "0", 10);
  const automationRuns = parseInt(automationsRow?.runs ?? "0", 10);
  const agentRuns = parseInt(agentRunsRow?.count ?? "0", 10);
  const chatTasks = parseInt(chatTasksRow?.count ?? "0", 10);
  const chatTasksDone = parseInt(chatTasksRow?.done ?? "0", 10);

  const weeklyLeadsData = fillWeek(weeklyLeads as DayCount[]);
  const weeklyProductionData = fillWeek(weeklyProduction as DayCount[]);
  const weeklyAgentRunsData = fillWeek(weeklyAgentRuns as DayCount[]);

  // Activity index: weighted sum of automated work
  const hoursAutomated =
    agentRuns * 0.25 +
    automationRuns * 0.15 +
    productionTasks * 0.5 +
    strategies * 1.0;

  const dollarsSaved = Math.round(hoursAutomated * 45);

  return NextResponse.json({
    totalLeads,
    totalSites,
    activeAgents,
    totalAgents,
    productionTasks,
    productionDone,
    strategies,
    automations,
    automationRuns,
    agentRuns,
    chatTasks,
    chatTasksDone,
    weeklyLeads: weeklyLeadsData,
    weeklyProduction: weeklyProductionData,
    weeklyAgentRuns: weeklyAgentRunsData,
    hoursAutomated: Math.round(hoursAutomated * 10) / 10,
    dollarsSaved,
    recentActivity,
  });
  } catch (e) {
    console.error("[analytics]", e);
    return NextResponse.json({
      totalLeads: 0, totalSites: 0, activeAgents: 0, totalAgents: 0,
      productionTasks: 0, productionDone: 0, strategies: 0, automations: 0,
      automationRuns: 0, agentRuns: 0, chatTasks: 0, chatTasksDone: 0,
      weeklyLeads: [0, 0, 0, 0, 0, 0, 0],
      weeklyProduction: [0, 0, 0, 0, 0, 0, 0],
      weeklyAgentRuns: [0, 0, 0, 0, 0, 0, 0],
      hoursAutomated: 0, dollarsSaved: 0, recentActivity: [],
      warning: "Some metrics could not be loaded. Check DSQL connection.",
    });
  }
}
