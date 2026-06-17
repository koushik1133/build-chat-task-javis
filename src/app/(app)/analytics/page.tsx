"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  TrendingUp, Users, Eye, Bot, ListTodo, Clock, DollarSign,
  Briefcase, Zap, Loader2, ChevronRight,
} from "lucide-react";
import { Button } from "@/components/ui/button";

type Analytics = {
  totalLeads: number;
  totalSites: number;
  activeAgents: number;
  totalAgents: number;
  productionTasks: number;
  productionDone: number;
  strategies: number;
  automations: number;
  automationRuns: number;
  agentRuns: number;
  chatTasks: number;
  chatTasksDone: number;
  warning?: string;
  weeklyLeads: number[];
  weeklyProduction: number[];
  weeklyAgentRuns: number[];
  hoursAutomated: number;
  dollarsSaved: number;
  recentActivity: { kind: string; label: string; created_at: string }[];
};

function MiniBarChart({ data, color = "#f97316" }: { data: number[]; color?: string }) {
  const max = Math.max(...data, 1);
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const today = new Date().getDay();
  const labels = Array.from({ length: 7 }, (_, i) => days[(today - 6 + i + 7) % 7]);

  return (
    <div className="mt-4">
      <div className="flex items-end gap-1.5 h-24">
        {data.map((v, i) => (
          <div key={i} className="flex-1 flex flex-col items-center gap-1">
            <div
              className="w-full rounded-sm transition-all duration-500"
              style={{ height: `${(v / max) * 80}px`, minHeight: v > 0 ? "4px" : "2px", background: color, opacity: v === 0 ? 0.2 : 1 }}
            />
          </div>
        ))}
      </div>
      <div className="flex gap-1.5 mt-1">
        {labels.map(d => (
          <div key={d} className="flex-1 text-center text-[9px] text-muted-foreground">{d}</div>
        ))}
      </div>
    </div>
  );
}

function AreaChart({ data, color = "#f97316" }: { data: number[]; color?: string }) {
  const max = Math.max(...data, 1);
  const w = 320, h = 80;
  const pts = data.map((v, i) => {
    const x = data.length > 1 ? (i / (data.length - 1)) * w : w / 2;
    const y = h - (v / max) * (h - 8);
    return `${x},${y}`;
  });
  const polyline = pts.join(" ");
  const area = `0,${h} ${polyline} ${w},${h}`;
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const today = new Date().getDay();
  const labels = Array.from({ length: 7 }, (_, i) => days[(today - 6 + i + 7) % 7]);

  return (
    <div className="mt-4">
      <svg viewBox={`0 0 ${w} ${h}`} className="w-full" preserveAspectRatio="none" style={{ height: 96 }}>
        <defs>
          <linearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.3" />
            <stop offset="100%" stopColor={color} stopOpacity="0.02" />
          </linearGradient>
        </defs>
        <polygon points={area} fill="url(#areaGrad)" />
        <polyline points={polyline} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <div className="flex mt-1">
        {labels.map(d => (
          <div key={d} className="flex-1 text-center text-[9px] text-muted-foreground">{d}</div>
        ))}
      </div>
    </div>
  );
}

const ACTIVITY_LABELS: Record<string, string> = {
  production: "Production",
  strategy: "Strategy",
  agent_run: "Agent run",
};

export default function AnalyticsPage() {
  const [stats, setStats] = useState<Analytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/analytics")
      .then(r => r.json())
      .then(d => {
        if (d.error) setError("Could not load analytics.");
        else setStats(d);
        setLoading(false);
      })
      .catch(() => { setError("Could not load analytics."); setLoading(false); });
  }, []);

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center text-muted-foreground text-sm gap-2">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading analytics…
      </div>
    );
  }

  if (error || !stats) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-3">
        <p className="text-sm text-muted-foreground">{error ?? "No data"}</p>
        <Button variant="outline" size="sm" onClick={() => window.location.reload()}>Retry</Button>
      </div>
    );
  }

  const juniorAnalysts = (stats.hoursAutomated / 160).toFixed(1);
  const completionRate = stats.productionTasks > 0
    ? Math.round((stats.productionDone / stats.productionTasks) * 100)
    : 0;

  const statCards = [
    { label: "Site Leads", value: stats.totalLeads, icon: Users, href: "/build", hint: "From AI Studio sites" },
    { label: "Live Sites", value: stats.totalSites, icon: Eye, href: "/build", hint: "Published sites" },
    { label: "Active Agents", value: stats.activeAgents, icon: Bot, href: "/agents", hint: `${stats.totalAgents} deployed total` },
    { label: "Production Tasks", value: stats.productionTasks, icon: ListTodo, href: "/production", hint: `${stats.productionDone} completed` },
  ];

  return (
    <div className="h-full overflow-y-auto px-8 py-8">
      <div className="max-w-5xl mx-auto space-y-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Data Analysis</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Live metrics from your sites, agents, production board, and automations.
          </p>
          {stats.warning && (
            <p className="mt-2 text-xs text-amber-600">{stats.warning}</p>
          )}
        </div>

        {/* Stat grid */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {statCards.map(({ label, value, icon: Icon, href, hint }) => (
            <Link key={label} href={href} className="rounded-xl border border-border bg-card p-4 hover:border-primary/30 transition-colors block">
              <div className="flex items-center justify-between mb-3">
                <Icon className="h-4 w-4 text-primary" />
                <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
              </div>
              <div className="text-2xl font-bold">{value}</div>
              <div className="text-xs text-muted-foreground mt-0.5">{label}</div>
              <div className="text-[10px] text-muted-foreground/70 mt-1">{hint}</div>
            </Link>
          ))}
        </div>

        {/* Secondary stats */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {[
            { label: "Strategies", value: stats.strategies, icon: Briefcase, href: "/strategy" },
            { label: "Automations", value: stats.automations, icon: Zap, href: "/automations" },
            { label: "Agent Runs", value: stats.agentRuns, icon: Bot, href: "/agents" },
            { label: "Chat Tasks", value: `${stats.chatTasksDone}/${stats.chatTasks}`, icon: ListTodo, href: "/tasks" },
          ].map(({ label, value, icon: Icon, href }) => (
            <Link key={label} href={href} className="rounded-lg border border-border/60 bg-card/50 px-3 py-2.5 flex items-center gap-2 hover:bg-card transition-colors">
              <Icon className="h-3.5 w-3.5 text-primary shrink-0" />
              <div>
                <div className="text-sm font-semibold">{value}</div>
                <div className="text-[10px] text-muted-foreground">{label}</div>
              </div>
            </Link>
          ))}
        </div>

        {/* ROI cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="rounded-xl border border-border bg-card p-5">
            <div className="flex items-center gap-2 mb-1">
              <div className="h-8 w-8 rounded-lg bg-primary/15 flex items-center justify-center">
                <Clock className="h-4 w-4 text-primary" />
              </div>
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Efficiency Index</div>
                <div className="text-2xl font-bold">{stats.hoursAutomated} hrs reclaimed</div>
              </div>
            </div>
            <p className="text-sm text-muted-foreground mt-2">
              Based on {stats.agentRuns} agent runs, {stats.automationRuns} automation fires,
              {stats.productionTasks} production tasks, and {stats.strategies} strategies generated.
            </p>
            {stats.automationRuns > 0 && (
              <div className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-green-700 bg-green-50 dark:bg-green-950 dark:text-green-400 rounded-full px-2.5 py-1">
                <TrendingUp className="h-3 w-3" /> {stats.automationRuns} automation runs total
              </div>
            )}
          </div>

          <div className="rounded-xl border border-border bg-card p-5">
            <div className="flex items-center gap-2 mb-1">
              <div className="h-8 w-8 rounded-lg bg-green-500/15 flex items-center justify-center">
                <DollarSign className="h-4 w-4 text-green-600" />
              </div>
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Estimated ROI</div>
                <div className="text-2xl font-bold">${stats.dollarsSaved.toLocaleString()} saved</div>
              </div>
            </div>
            <p className="text-sm text-muted-foreground mt-2">
              At $45/hr operational benchmark. Your agent fleet is performing at the capacity of{" "}
              <strong className="text-primary">{juniorAnalysts} junior analysts</strong>.
            </p>
            {stats.productionTasks > 0 && (
              <div className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-primary bg-primary/10 rounded-full px-2.5 py-1">
                <TrendingUp className="h-3 w-3" /> {completionRate}% production completion rate
              </div>
            )}
          </div>
        </div>

        {/* Charts */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="rounded-xl border border-border bg-card p-5">
            <div className="text-sm font-medium mb-1">Weekly Lead Acquisition</div>
            <div className="text-xs text-muted-foreground">Leads from AI Studio sites — last 7 days</div>
            {stats.weeklyLeads.some(v => v > 0) ? (
              <MiniBarChart data={stats.weeklyLeads} color="hsl(25 95% 53%)" />
            ) : (
              <p className="text-xs text-muted-foreground mt-6 py-8 text-center border border-dashed border-border rounded-lg">
                No leads yet. Publish a site in AI Studio to start capturing leads.
              </p>
            )}
          </div>
          <div className="rounded-xl border border-border bg-card p-5">
            <div className="text-sm font-medium mb-1">Weekly Agent Activity</div>
            <div className="text-xs text-muted-foreground">Agent runs per day — last 7 days</div>
            {stats.weeklyAgentRuns.some(v => v > 0) ? (
              <AreaChart data={stats.weeklyAgentRuns} color="hsl(220 70% 50%)" />
            ) : (
              <p className="text-xs text-muted-foreground mt-6 py-8 text-center border border-dashed border-border rounded-lg">
                No agent runs yet. Set up an automation with Deploy Agent.
              </p>
            )}
          </div>
        </div>

        {/* Production trend */}
        <div className="rounded-xl border border-border bg-card p-5">
          <div className="text-sm font-medium mb-1">Production Tasks Created</div>
          <div className="text-xs text-muted-foreground">New tasks added to the board — last 7 days</div>
          {stats.weeklyProduction.some(v => v > 0) ? (
            <MiniBarChart data={stats.weeklyProduction} color="hsl(142 60% 40%)" />
          ) : (
            <p className="text-xs text-muted-foreground mt-6 py-8 text-center border border-dashed border-border rounded-lg">
              No production tasks yet. Push tasks from Strategy Hub or add cards on the Production board.
            </p>
          )}
        </div>

        {/* Recent activity */}
        {stats.recentActivity.length > 0 && (
          <div className="rounded-xl border border-border bg-card p-5 space-y-3">
            <h2 className="text-sm font-semibold">Recent activity</h2>
            <div className="space-y-2">
              {stats.recentActivity.map((a, i) => (
                <div key={i} className="flex items-center justify-between gap-3 text-xs">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-[10px] font-medium rounded-full px-2 py-0.5 bg-secondary shrink-0">
                      {ACTIVITY_LABELS[a.kind] ?? a.kind}
                    </span>
                    <span className="truncate text-muted-foreground">{a.label}</span>
                  </div>
                  <span className="text-[10px] text-muted-foreground shrink-0">
                    {new Date(a.created_at).toLocaleString()}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
