"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import {
  Building2, Briefcase, Users, Plus, AlertTriangle,
  DollarSign, Sparkles, Send, RefreshCw,
  ShieldAlert, Cpu, X, Loader2,
  TrendingUp, Layers, CheckSquare, Terminal
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { InfoTooltip } from "@/components/ui/info-tooltip";

// ─── Types ─────────────────────────────────────────────────────────────────────

type AgencyProject = {
  id: string;
  client_id: string | null;
  title: string;
  project_type: "website" | "ai_agent" | "chatbot" | "automation" | "mobile_app";
  assigned_employee_id: string | null;
  assigned_employee_name: string | null;
  status: "intake" | "proposal" | "in_progress" | "in_review" | "delivered";
  progress_pct: number;
  budget: number;
  deadline: string | null;
  deliverable_link: string | null;
  repo_url: string | null;
  created_at: string;
};

type AgencyClient = {
  id: string;
  company_name: string;
  contact_person: string | null;
  email: string | null;
  industry: string | null;
  website: string | null;
  total_spend: number;
  status: string;
};

type AgencyEmployee = {
  id: string;
  name: string;
  email: string | null;
  role: string;
  skills: string | null;
  slack_handle: string | null;
  active_projects: number;
};

type DailyStandup = {
  id: string;
  employee_id: string;
  employee_name: string;
  project_title: string | null;
  tasks_today: string;
  plan_tomorrow: string | null;
  blockers: string | null;
  risk_level: "low" | "medium" | "high";
  ai_summary: string | null;
  created_at: string;
};

type Proposal = {
  id: string;
  client_name: string;
  project_type: string;
  raw_requirements: string;
  technical_spec: string;
  architecture: string;
  milestones: string; // JSON string
  cost_estimate: number;
  estimated_days: number;
  status: string;
  created_at: string;
};

type Audit = {
  id: string;
  client_name: string;
  industry: string;
  current_tech: string;
  ai_readiness_score: number;
  recommended_agents: string; // JSON string
  estimated_roi: string;
  audit_report: string;
  created_at: string;
};

type Tab = "oversight" | "projects" | "proposals" | "audits" | "standups" | "slack";

const PROJECT_TYPE_LABELS: Record<string, { label: string; icon: string; bg: string }> = {
  website:    { label: "Website", icon: "🌐", bg: "bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-400" },
  ai_agent:   { label: "AI Agent", icon: "🤖", bg: "bg-purple-50 text-purple-700 dark:bg-purple-950 dark:text-purple-400" },
  chatbot:    { label: "Chatbot", icon: "💬", bg: "bg-green-50 text-green-700 dark:bg-green-950 dark:text-green-400" },
  automation: { label: "Automation", icon: "⚡", bg: "bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-400" },
  mobile_app: { label: "Mobile App", icon: "📱", bg: "bg-indigo-50 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-400" },
};

const STATUS_BADGES: Record<string, string> = {
  intake: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
  proposal: "bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-400",
  in_progress: "bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-400",
  in_review: "bg-purple-50 text-purple-700 dark:bg-purple-950 dark:text-purple-400",
  delivered: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400",
};

export default function AgencyPage() {
  const [tab, setTab] = useState<Tab>("oversight");

  // Data
  const [projects, setProjects]   = useState<AgencyProject[]>([]);
  const [clients, setClients]     = useState<AgencyClient[]>([]);
  const [employees, setEmployees] = useState<AgencyEmployee[]>([]);
  const [standups, setStandups]   = useState<DailyStandup[]>([]);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [audits, setAudits]       = useState<Audit[]>([]);

  // Loaders
  const [loading, setLoading]                 = useState(true);
  const [generatingProposal, setGenProposal] = useState(false);
  const [generatingAudit, setGenAudit]       = useState(false);
  const [sendingSlack, setSendingSlack]       = useState(false);

  // Modals
  const [showAddProject, setShowAddProject]   = useState(false);
  const [showAddEmployee, setShowAddEmployee] = useState(false);
  const [showAddClient, setShowAddClient]     = useState(false);
  const [showStandupForm, setShowStandupForm] = useState(false);

  // Forms
  const [projectForm, setProjectForm] = useState({
    title: "",
    project_type: "website" as AgencyProject["project_type"],
    assigned_employee_id: "",
    budget: 5000,
    deadline: "",
    repo_url: "",
  });

  const [employeeForm, setEmployeeForm] = useState({
    name: "",
    email: "",
    role: "Full Stack Developer",
    skills: "React, Node.js, Python, AI Agents",
    slack_handle: "",
  });

  const [clientForm, setClientForm] = useState({
    company_name: "",
    contact_person: "",
    email: "",
    industry: "Healthcare / SaaS",
    website: "",
  });

  const [proposalForm, setProposalForm] = useState({
    client_name: "",
    project_type: "ai_agent",
    raw_requirements: "",
  });

  const [auditForm, setAuditForm] = useState({
    client_name: "",
    industry: "Healthcare",
    current_tech: "Manual customer support phone lines & legacy Webforms",
  });

  const [standupForm, setStandupForm] = useState({
    employee_name: "",
    project_title: "",
    tasks_today: "",
    plan_tomorrow: "",
    blockers: "",
  });

  // Slack simulator
  const [slackCmd, setSlackCmd] = useState("/status");
  const [slackText, setSlackText] = useState("");
  const [slackLogs, setSlackLogs] = useState<{ cmd: string; resp: string; time: string }[]>([]);

  // ─── Fetch All Agency Data ────────────────────────────────────────────────────

  const fetchAllData = useCallback(async () => {
    setLoading(true);
    try {
      const [projRes, clientRes, empRes, standupRes, propRes, auditRes] = await Promise.all([
        fetch("/api/agency/projects").then(r => r.json()).catch(() => ({})),
        fetch("/api/agency/clients").then(r => r.json()).catch(() => ({})),
        fetch("/api/agency/employees").then(r => r.json()).catch(() => ({})),
        fetch("/api/agency/standups").then(r => r.json()).catch(() => ({})),
        fetch("/api/agency/proposals/generate").then(r => r.json()).catch(() => ({})),
        fetch("/api/agency/audits/generate").then(r => r.json()).catch(() => ({})),
      ]);

      setProjects(projRes.projects ?? []);
      setClients(clientRes.clients ?? []);
      setEmployees(empRes.employees ?? []);
      setStandups(standupRes.standups ?? []);
      setProposals(propRes.proposals ?? []);
      setAudits(auditRes.audits ?? []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchAllData(); }, [fetchAllData]);

  // ─── Actions ──────────────────────────────────────────────────────────────────

  async function handleCreateProject() {
    if (!projectForm.title) return;
    const emp = employees.find(e => e.id === projectForm.assigned_employee_id);
    const res = await fetch("/api/agency/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...projectForm,
        assigned_employee_name: emp?.name ?? null,
      }),
    });
    const data = await res.json();
    if (data.project) {
      setProjects(p => [data.project, ...p]);
      setShowAddProject(false);
      setProjectForm({ title: "", project_type: "website", assigned_employee_id: "", budget: 5000, deadline: "", repo_url: "" });
    }
  }

  async function handleCreateEmployee() {
    if (!employeeForm.name) return;
    const res = await fetch("/api/agency/employees", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(employeeForm),
    });
    const data = await res.json();
    if (data.employee) {
      setEmployees(e => [...e, data.employee]);
      setShowAddEmployee(false);
      setEmployeeForm({ name: "", email: "", role: "Full Stack Developer", skills: "React, Node.js, Python, AI Agents", slack_handle: "" });
    }
  }

  async function handleCreateClient() {
    if (!clientForm.company_name) return;
    const res = await fetch("/api/agency/clients", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(clientForm),
    });
    const data = await res.json();
    if (data.client) {
      setClients(c => [data.client, ...c]);
      setShowAddClient(false);
      setClientForm({ company_name: "", contact_person: "", email: "", industry: "Healthcare / SaaS", website: "" });
    }
  }

  async function handleGenerateProposal() {
    if (!proposalForm.client_name || !proposalForm.raw_requirements) return;
    setGenProposal(true);
    try {
      const res = await fetch("/api/agency/proposals/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(proposalForm),
      });
      const data = await res.json();
      if (data.proposal) {
        setProposals(p => [data.proposal, ...p]);
        setProposalForm({ client_name: "", project_type: "ai_agent", raw_requirements: "" });
      } else {
        alert(data.error ?? "Failed to generate proposal.");
      }
    } finally {
      setGenProposal(false);
    }
  }

  async function handleGenerateAudit() {
    if (!auditForm.client_name) return;
    setGenAudit(true);
    try {
      const res = await fetch("/api/agency/audits/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(auditForm),
      });
      const data = await res.json();
      if (data.audit) {
        setAudits(a => [data.audit, ...a]);
        setAuditForm({ client_name: "", industry: "Healthcare", current_tech: "" });
      } else {
        alert(data.error ?? "Failed to generate audit.");
      }
    } finally {
      setGenAudit(false);
    }
  }

  async function handleSubmitStandup() {
    if (!standupForm.employee_name || !standupForm.tasks_today) return;
    const emp = employees.find(e => e.name === standupForm.employee_name);
    const res = await fetch("/api/agency/standups", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...standupForm,
        employee_id: emp?.id ?? "emp-1",
      }),
    });
    const data = await res.json();
    if (data.standup) {
      setStandups(s => [data.standup, ...s]);
      setShowStandupForm(false);
      setStandupForm({ employee_name: "", project_title: "", tasks_today: "", plan_tomorrow: "", blockers: "" });
    }
  }

  async function handleSendSlack() {
    setSendingSlack(true);
    try {
      const res = await fetch("/api/agency/slack-bot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: slackCmd, text: slackText, user_name: "Agency Boss" }),
      });
      const data = await res.json();
      if (data.response) {
        setSlackLogs(logs => [{ cmd: `${slackCmd} ${slackText}`, resp: data.response, time: new Date().toLocaleTimeString() }, ...logs]);
        setSlackText("");
      }
    } finally {
      setSendingSlack(false);
    }
  }

  async function convertProposalToProject(prop: Proposal) {
    const res = await fetch("/api/agency/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: `${prop.client_name} — ${prop.project_type.toUpperCase()}`,
        project_type: prop.project_type,
        budget: prop.cost_estimate,
      }),
    });
    const data = await res.json();
    if (data.project) {
      setProjects(p => [data.project, ...p]);
      setTab("projects");
    }
  }

  // ─── Computed Stats ───────────────────────────────────────────────────────────

  const totalRevenue    = projects.reduce((acc, p) => acc + (p.budget || 0), 0);
  const activeCount     = projects.filter(p => p.status !== "delivered").length;
  const highRiskStandup = standups.filter(s => s.risk_level === "high" || s.risk_level === "medium");

  // ─── Tabs Configuration ───────────────────────────────────────────────────────

  const tabs: { id: Tab; label: string; icon: React.ReactNode }[] = [
    { id: "oversight", label: "Boss Oversight", icon: <Building2 className="h-3.5 w-3.5" /> },
    { id: "projects",  label: "Client Projects", icon: <Briefcase className="h-3.5 w-3.5" /> },
    { id: "proposals", label: "AI Proposals", icon: <Sparkles className="h-3.5 w-3.5" /> },
    { id: "audits",    label: "AI Readiness Audits", icon: <Cpu className="h-3.5 w-3.5" /> },
    { id: "standups",  label: "Daily Standups", icon: <CheckSquare className="h-3.5 w-3.5" /> },
    { id: "slack",     label: "Slack Agency Bot", icon: <Terminal className="h-3.5 w-3.5" /> },
  ];

  return (
    <div className="h-full overflow-y-auto overflow-x-hidden px-4 py-5 sm:px-6 sm:py-7 lg:px-8 lg:py-8">
      <div className="mx-auto w-full max-w-7xl space-y-6">

        {/* ── Page Header ── */}
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h1 className="text-xl font-semibold tracking-tight sm:text-2xl flex items-center gap-2">
              <Building2 className="h-6 w-6 text-primary" />
              Agency Command Center
              <InfoTooltip text="All-in-one operations hub for AI & software consultancies. Track client builds, employee standups, AI proposals, and project profit margins." />
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Manage client projects, developers, daily standup risks, and automated AI client proposals.
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <Button variant="outline" size="sm" onClick={() => setShowAddClient(true)}>
              <Plus className="h-3.5 w-3.5" /> Add Client
            </Button>
            <Button variant="outline" size="sm" onClick={() => setShowAddEmployee(true)}>
              <Users className="h-3.5 w-3.5" /> Add Employee
            </Button>
            <Button size="sm" onClick={() => setShowAddProject(true)}>
              <Plus className="h-3.5 w-3.5" /> New Client Project
            </Button>
          </div>
        </div>

        {/* ── Tabs Navigation ── */}
        <div className="flex gap-1 overflow-x-auto border-b border-border pb-0 -mb-6">
          {tabs.map(t => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`flex items-center gap-1.5 px-3.5 py-2.5 text-xs font-medium whitespace-nowrap border-b-2 transition-colors ${
                tab === t.id
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground hover:border-border"
              }`}
            >
              {t.icon}{t.label}
            </button>
          ))}
        </div>

        <div className="pt-2">
          {loading && (
            <div className="text-xs text-muted-foreground flex items-center gap-1.5 py-1 mb-2">
              <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" /> Syncing agency pipeline...
            </div>
          )}

          {/* ════════════════════════════════════════ BOSS OVERSIGHT TAB */}
          {tab === "oversight" && (
            <div className="space-y-6">

              {/* Stats Cards */}
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                <div className="rounded-xl border border-border bg-card p-4">
                  <div className="flex items-center justify-between text-muted-foreground mb-2">
                    <span className="text-xs">Active Client Projects</span>
                    <Briefcase className="h-4 w-4 text-primary" />
                  </div>
                  <div className="text-2xl font-bold">{activeCount}</div>
                  <div className="text-[11px] text-muted-foreground mt-1">Total pipeline: {projects.length}</div>
                </div>

                <div className="rounded-xl border border-border bg-card p-4">
                  <div className="flex items-center justify-between text-muted-foreground mb-2">
                    <span className="text-xs">Contract Value</span>
                    <DollarSign className="h-4 w-4 text-emerald-500" />
                  </div>
                  <div className="text-2xl font-bold">${totalRevenue.toLocaleString()}</div>
                  <div className="text-[11px] text-emerald-600 dark:text-emerald-400 mt-1 flex items-center gap-0.5">
                    <TrendingUp className="h-3 w-3" /> Combined client budget
                  </div>
                </div>

                <div className="rounded-xl border border-border bg-card p-4">
                  <div className="flex items-center justify-between text-muted-foreground mb-2">
                    <span className="text-xs">Agency Developers</span>
                    <Users className="h-4 w-4 text-blue-500" />
                  </div>
                  <div className="text-2xl font-bold">{employees.length}</div>
                  <div className="text-[11px] text-muted-foreground mt-1">
                    {clients.length > 0 ? `${clients.length} active client accounts` : "Active team members"}
                  </div>
                </div>

                <div className="rounded-xl border border-border bg-card p-4">
                  <div className="flex items-center justify-between text-muted-foreground mb-2">
                    <span className="text-xs">AI Risk Alerts</span>
                    <ShieldAlert className="h-4 w-4 text-amber-500" />
                  </div>
                  <div className="text-2xl font-bold text-amber-600 dark:text-amber-400">
                    {highRiskStandup.length}
                  </div>
                  <div className="text-[11px] text-muted-foreground mt-1">Blockers or delay alerts</div>
                </div>
              </div>

              {/* AI Risk Alerts & Executive Feed */}
              {highRiskStandup.length > 0 && (
                <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-5 space-y-3">
                  <div className="flex items-center gap-2">
                    <AlertTriangle className="h-4 w-4 text-amber-500" />
                    <h2 className="text-sm font-semibold text-amber-700 dark:text-amber-400">
                      AI Executive Risk Alerts
                    </h2>
                  </div>
                  <div className="space-y-2">
                    {highRiskStandup.map(s => (
                      <div key={s.id} className="rounded-lg border border-border/60 bg-card p-3 flex items-start justify-between gap-3 text-xs">
                        <div>
                          <div className="font-semibold flex items-center gap-2">
                            <span>{s.employee_name}</span>
                            <span className="text-muted-foreground font-normal">• Project: {s.project_title || "General"}</span>
                          </div>
                          <p className="text-muted-foreground mt-1 leading-relaxed">
                            {s.ai_summary || s.blockers}
                          </p>
                        </div>
                        <span className={`px-2 py-0.5 rounded text-[10px] uppercase font-bold shrink-0 ${
                          s.risk_level === "high" ? "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-400" : "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-400"
                        }`}>
                          {s.risk_level} Risk
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Projects Overview Grid */}
              <div className="rounded-xl border border-border bg-card p-5 space-y-4">
                <div className="flex items-center justify-between">
                  <h2 className="text-sm font-semibold flex items-center gap-2">
                    <Layers className="h-4 w-4 text-primary" /> Active Client Projects Overview
                  </h2>
                  <Button size="sm" variant="ghost" className="text-xs" onClick={() => setTab("projects")}>
                    View All Projects →
                  </Button>
                </div>

                {projects.length === 0 ? (
                  <div className="text-center py-8 text-xs text-muted-foreground">
                    No client projects created yet. Click <strong>New Client Project</strong> above to add one.
                  </div>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {projects.slice(0, 4).map(p => {
                      const typeCfg = PROJECT_TYPE_LABELS[p.project_type] ?? { label: p.project_type, icon: "💻", bg: "bg-secondary" };
                      return (
                        <div key={p.id} className="rounded-lg border border-border/80 p-4 space-y-3">
                          <div className="flex items-start justify-between gap-2">
                            <div>
                              <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full inline-flex items-center gap-1 ${typeCfg.bg}`}>
                                {typeCfg.icon} {typeCfg.label}
                              </span>
                              <h3 className="font-semibold text-sm mt-1">{p.title}</h3>
                            </div>
                            <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full capitalize ${STATUS_BADGES[p.status]}`}>
                              {p.status.replace("_", " ")}
                            </span>
                          </div>

                          {/* Progress bar */}
                          <div>
                            <div className="flex justify-between text-[11px] text-muted-foreground mb-1">
                              <span>Progress</span>
                              <span>{p.progress_pct}%</span>
                            </div>
                            <div className="h-2 w-full bg-secondary rounded-full overflow-hidden">
                              <div className="h-full bg-primary transition-all" style={{ width: `${p.progress_pct}%` }} />
                            </div>
                          </div>

                          <div className="flex items-center justify-between text-xs text-muted-foreground pt-1 border-t border-border/40">
                            <span>Assignee: <strong>{p.assigned_employee_name || "Unassigned"}</strong></span>
                            <span>Budget: <strong>${Number(p.budget ?? 0).toLocaleString()}</strong></span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

            </div>
          )}

          {/* ════════════════════════════════════════ CLIENT PROJECTS TAB */}
          {tab === "projects" && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">{projects.length} Client Projects</span>
                <Button size="sm" onClick={() => setShowAddProject(true)}>
                  <Plus className="h-3.5 w-3.5" /> Add Project
                </Button>
              </div>

              {projects.length === 0 ? (
                <div className="rounded-xl border border-dashed border-border p-12 text-center">
                  <Briefcase className="h-8 w-8 text-muted-foreground mx-auto mb-3" />
                  <p className="text-sm font-medium mb-1">No client projects found</p>
                  <p className="text-xs text-muted-foreground mb-4">
                    Create client builds (Websites, Chatbots, AI Agents, Mobile Apps, Automations) and assign developers.
                  </p>
                  <Button size="sm" onClick={() => setShowAddProject(true)}>
                    <Plus className="h-3.5 w-3.5" /> Create First Project
                  </Button>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {projects.map(p => {
                    const typeCfg = PROJECT_TYPE_LABELS[p.project_type] ?? { label: p.project_type, icon: "💻", bg: "bg-secondary" };
                    return (
                      <div key={p.id} className="rounded-xl border border-border bg-card p-5 space-y-4 hover:border-primary/40 transition-colors">
                        <div className="flex items-start justify-between gap-2">
                          <span className={`text-[10px] font-medium px-2.5 py-0.5 rounded-full inline-flex items-center gap-1 ${typeCfg.bg}`}>
                            {typeCfg.icon} {typeCfg.label}
                          </span>
                          <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full capitalize ${STATUS_BADGES[p.status]}`}>
                            {p.status.replace("_", " ")}
                          </span>
                        </div>

                        <div>
                          <h3 className="font-semibold text-base leading-tight">{p.title}</h3>
                          <p className="text-xs text-muted-foreground mt-1">
                            Assigned to: <strong className="text-foreground">{p.assigned_employee_name || "Unassigned"}</strong>
                          </p>
                        </div>

                        {/* Progress */}
                        <div>
                          <div className="flex justify-between text-xs text-muted-foreground mb-1">
                            <span>Completion</span>
                            <span>{p.progress_pct}%</span>
                          </div>
                          <div className="h-2 w-full bg-secondary rounded-full overflow-hidden">
                            <div className="h-full bg-primary transition-all" style={{ width: `${p.progress_pct}%` }} />
                          </div>
                        </div>

                        <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground pt-2 border-t border-border/40">
                          <div>
                            <span className="block text-[10px]">Budget</span>
                            <strong className="text-foreground">${Number(p.budget ?? 0).toLocaleString()}</strong>
                          </div>
                          <div>
                            <span className="block text-[10px]">Deadline</span>
                            <strong className="text-foreground">{p.deadline ? new Date(p.deadline).toLocaleDateString() : "Flexible"}</strong>
                          </div>
                        </div>

                        {/* Quick links to Kernel Hub tools */}
                        <div className="flex items-center gap-2 pt-2">
                          <Link
                            href="/build"
                            className="flex-1 text-center py-1.5 px-2 rounded bg-primary/10 text-primary text-xs font-medium hover:bg-primary/20 transition-colors"
                          >
                            AI Build Site
                          </Link>
                          <Link
                            href="/agents/swarms"
                            className="flex-1 text-center py-1.5 px-2 rounded bg-purple-500/10 text-purple-600 dark:text-purple-400 text-xs font-medium hover:bg-purple-500/20 transition-colors"
                          >
                            Build Agent
                          </Link>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* ════════════════════════════════════════ AI PROPOSALS TAB */}
          {tab === "proposals" && (
            <div className="space-y-6">
              {/* Proposal Intake Form */}
              <div className="rounded-xl border border-border bg-card p-5 space-y-4 max-w-3xl">
                <div className="flex items-center gap-2">
                  <Sparkles className="h-5 w-5 text-primary" />
                  <div>
                    <h2 className="text-base font-semibold">AI Technical Proposal Generator</h2>
                    <p className="text-xs text-muted-foreground">
                      Input raw client requirements → AI generates full technical specs, tech architecture, milestone schedules, and cost estimates.
                    </p>
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="text-xs font-medium text-muted-foreground mb-1 block">Client Company Name *</label>
                    <input
                      value={proposalForm.client_name}
                      onChange={e => setProposalForm(f => ({ ...f, client_name: e.target.value }))}
                      placeholder="e.g. Apex Health Systems"
                      className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/30"
                    />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-muted-foreground mb-1 block">Project Type</label>
                    <select
                      value={proposalForm.project_type}
                      onChange={e => setProposalForm(f => ({ ...f, project_type: e.target.value }))}
                      className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none"
                    >
                      <option value="website">Custom Website / Portal</option>
                      <option value="ai_agent">AI Agent Squad</option>
                      <option value="chatbot">Customer Support Chatbot</option>
                      <option value="automation">Workflow Automation</option>
                      <option value="mobile_app">Mobile App</option>
                    </select>
                  </div>
                </div>

                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-1 block">Client Requirements / Raw Description *</label>
                  <textarea
                    value={proposalForm.raw_requirements}
                    onChange={e => setProposalForm(f => ({ ...f, raw_requirements: e.target.value }))}
                    rows={4}
                    placeholder="Describe what the client wants (e.g. They need an automated HIPAA-compliant patient intake chatbot that integrates with their EHR system, books appointments, and sends SMS reminders)."
                    className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/30 resize-y"
                  />
                </div>

                <Button onClick={handleGenerateProposal} disabled={generatingProposal || !proposalForm.client_name.trim() || !proposalForm.raw_requirements.trim()}>
                  {generatingProposal ? <RefreshCw className="h-4 w-4 animate-spin mr-2" /> : <Sparkles className="h-4 w-4 mr-2" />}
                  {generatingProposal ? "Generating Proposal Architecture..." : "Generate AI Technical Proposal"}
                </Button>
              </div>

              {/* Proposals Feed */}
              {proposals.length > 0 && (
                <div className="space-y-4">
                  <h3 className="text-sm font-semibold">Generated Proposals ({proposals.length})</h3>
                  <div className="space-y-4">
                    {proposals.map(prop => {
                      let milestonesList: string[] = [];
                      try { milestonesList = JSON.parse(prop.milestones); } catch { /* ok */ }

                      return (
                        <div key={prop.id} className="rounded-xl border border-border bg-card p-5 space-y-4">
                          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-border/40 pb-3">
                            <div>
                              <h4 className="font-bold text-base">{prop.client_name} — {prop.project_type.toUpperCase()}</h4>
                              <p className="text-xs text-muted-foreground mt-0.5">Requirements: {prop.raw_requirements}</p>
                            </div>
                            <div className="flex items-center gap-3 shrink-0">
                              <div className="text-right">
                                <div className="text-lg font-bold text-emerald-600 dark:text-emerald-400">
                                  ${prop.cost_estimate?.toLocaleString()}
                                </div>
                                <div className="text-[10px] text-muted-foreground">{prop.estimated_days} business days</div>
                              </div>
                              <Button size="sm" onClick={() => convertProposalToProject(prop)}>
                                Convert to Active Project →
                              </Button>
                            </div>
                          </div>

                          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
                            <div className="space-y-1">
                              <span className="font-semibold text-muted-foreground block">Technical Specification:</span>
                              <p className="text-foreground leading-relaxed whitespace-pre-wrap">{prop.technical_spec}</p>
                            </div>
                            <div className="space-y-1">
                              <span className="font-semibold text-muted-foreground block">Architecture Stack:</span>
                              <p className="text-foreground leading-relaxed whitespace-pre-wrap">{prop.architecture}</p>
                            </div>
                          </div>

                          {milestonesList.length > 0 && (
                            <div className="pt-2">
                              <span className="font-semibold text-xs text-muted-foreground block mb-2">Milestone Schedule:</span>
                              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                                {milestonesList.map((m, idx) => (
                                  <div key={idx} className="rounded bg-secondary/50 p-2 text-xs flex items-center gap-2">
                                    <span className="h-5 w-5 rounded-full bg-primary/20 text-primary flex items-center justify-center font-bold text-[10px] shrink-0">
                                      {idx + 1}
                                    </span>
                                    <span>{m}</span>
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ════════════════════════════════════════ AI READINESS AUDITS TAB */}
          {tab === "audits" && (
            <div className="space-y-6">
              {/* Audit Generator Form */}
              <div className="rounded-xl border border-border bg-card p-5 space-y-4 max-w-3xl">
                <div className="flex items-center gap-2">
                  <Cpu className="h-5 w-5 text-purple-500" />
                  <div>
                    <h2 className="text-base font-semibold">Client AI Transformation Audit Engine</h2>
                    <p className="text-xs text-muted-foreground">
                      Run an AI Readiness & Tech Upgrade Audit on a potential or existing client company to pitch automation services.
                    </p>
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="text-xs font-medium text-muted-foreground mb-1 block">Client Company Name *</label>
                    <input
                      value={auditForm.client_name}
                      onChange={e => setAuditForm(f => ({ ...f, client_name: e.target.value }))}
                      placeholder="e.g. Metro Logistics"
                      className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/30"
                    />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-muted-foreground mb-1 block">Industry</label>
                    <input
                      value={auditForm.industry}
                      onChange={e => setAuditForm(f => ({ ...f, industry: e.target.value }))}
                      placeholder="Logistics / Healthcare / E-commerce"
                      className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none"
                    />
                  </div>
                </div>

                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-1 block">Current Tech Stack & Manual Workflows</label>
                  <textarea
                    value={auditForm.current_tech}
                    onChange={e => setAuditForm(f => ({ ...f, current_tech: e.target.value }))}
                    rows={3}
                    placeholder="Describe their existing software (e.g. Excel spreadsheets, manual email dispatches, legacy SQL database)."
                    className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/30"
                  />
                </div>

                <Button onClick={handleGenerateAudit} disabled={generatingAudit || !auditForm.client_name.trim()}>
                  {generatingAudit ? <RefreshCw className="h-4 w-4 animate-spin mr-2" /> : <Cpu className="h-4 w-4 mr-2 text-purple-400" />}
                  {generatingAudit ? "Analyzing Tech Stack..." : "Run AI Readiness Audit"}
                </Button>
              </div>

              {/* Audit Reports List */}
              {audits.length > 0 && (
                <div className="space-y-4">
                  <h3 className="text-sm font-semibold">Generated Client Audits ({audits.length})</h3>
                  <div className="space-y-4">
                    {audits.map(aud => {
                      let agentsList: string[] = [];
                      try { agentsList = JSON.parse(aud.recommended_agents); } catch { /* ok */ }

                      return (
                        <div key={aud.id} className="rounded-xl border border-border bg-card p-5 space-y-4">
                          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-border/40 pb-3">
                            <div>
                              <h4 className="font-bold text-base">{aud.client_name} ({aud.industry})</h4>
                              <p className="text-xs text-muted-foreground">Current Stack: {aud.current_tech}</p>
                            </div>
                            <div className="flex items-center gap-3 shrink-0">
                              <div className="text-center px-3 py-1 rounded bg-purple-500/10 border border-purple-500/20">
                                <div className="text-lg font-bold text-purple-600 dark:text-purple-400">
                                  {aud.ai_readiness_score}/100
                                </div>
                                <div className="text-[10px] text-muted-foreground">AI Readiness</div>
                              </div>
                              <div className="text-center px-3 py-1 rounded bg-emerald-500/10 border border-emerald-500/20">
                                <div className="text-sm font-bold text-emerald-600 dark:text-emerald-400">
                                  {aud.estimated_roi}
                                </div>
                                <div className="text-[10px] text-muted-foreground">Projected ROI</div>
                              </div>
                            </div>
                          </div>

                          {agentsList.length > 0 && (
                            <div>
                              <span className="font-semibold text-xs text-muted-foreground block mb-2">Recommended Agent Solutions:</span>
                              <div className="flex flex-wrap gap-2">
                                {agentsList.map((agent, i) => (
                                  <span key={i} className="text-xs px-2.5 py-1 rounded-full bg-primary/10 text-primary border border-primary/20 font-medium">
                                    🤖 {agent}
                                  </span>
                                ))}
                              </div>
                            </div>
                          )}

                          <div className="pt-2 border-t border-border/40">
                            <span className="font-semibold text-xs text-muted-foreground block mb-1">Executive Audit Report:</span>
                            <pre className="text-xs text-muted-foreground font-sans whitespace-pre-wrap leading-relaxed">
                              {aud.audit_report}
                            </pre>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ════════════════════════════════════════ DAILY STANDUPS TAB */}
          {tab === "standups" && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-sm font-semibold">Employee Daily Standups & Risk Feed</h2>
                  <p className="text-xs text-muted-foreground">Daily progress logs submitted by developers with automated AI blocker extraction.</p>
                </div>
                <Button size="sm" onClick={() => setShowStandupForm(true)}>
                  <Plus className="h-3.5 w-3.5" /> Submit Standup
                </Button>
              </div>

              {standups.length === 0 ? (
                <div className="rounded-xl border border-dashed border-border p-12 text-center">
                  <CheckSquare className="h-8 w-8 text-muted-foreground mx-auto mb-3" />
                  <p className="text-sm font-medium mb-1">No standup logs submitted yet</p>
                  <p className="text-xs text-muted-foreground mb-4">Log daily developer updates to track progress and flag technical blockers.</p>
                  <Button size="sm" onClick={() => setShowStandupForm(true)}>
                    <Plus className="h-3.5 w-3.5" /> Log First Standup
                  </Button>
                </div>
              ) : (
                <div className="space-y-3">
                  {standups.map(s => (
                    <div key={s.id} className="rounded-xl border border-border bg-card p-4 space-y-2">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-sm">{s.employee_name}</span>
                          <span className="text-xs text-muted-foreground">• Project: {s.project_title || "General"}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded ${
                            s.risk_level === "high" ? "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-400" :
                            s.risk_level === "medium" ? "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-400" :
                            "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400"
                          }`}>
                            {s.risk_level} Risk
                          </span>
                          <span className="text-[10px] text-muted-foreground">{new Date(s.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                        </div>
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs pt-1">
                        <div>
                          <strong className="text-muted-foreground block text-[10px]">Tasks Completed Today:</strong>
                          <p className="text-foreground leading-relaxed">{s.tasks_today}</p>
                        </div>
                        {s.plan_tomorrow && (
                          <div>
                            <strong className="text-muted-foreground block text-[10px]">Plan for Tomorrow:</strong>
                            <p className="text-foreground leading-relaxed">{s.plan_tomorrow}</p>
                          </div>
                        )}
                      </div>

                      {s.blockers && (
                        <div className="rounded bg-red-500/10 border border-red-500/20 p-2 text-xs text-red-600 dark:text-red-400">
                          <strong>Blocker:</strong> {s.blockers}
                        </div>
                      )}

                      {s.ai_summary && (
                        <div className="text-[11px] text-muted-foreground pt-1 flex items-center gap-1.5 italic border-t border-border/40">
                          <Sparkles className="h-3 w-3 text-primary shrink-0" />
                          <span>AI Summary: {s.ai_summary}</span>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ════════════════════════════════════════ SLACK AGENCY BOT TAB */}
          {tab === "slack" && (
            <div className="space-y-4 max-w-4xl">
              <div className="rounded-xl border border-border bg-card p-5 space-y-4">
                <div className="flex items-center justify-between border-b border-border/40 pb-3">
                  <div className="flex items-center gap-2">
                    <Terminal className="h-5 w-5 text-emerald-500" />
                    <div>
                      <h2 className="text-base font-semibold">Slack Agency Bot Workspace</h2>
                      <p className="text-xs text-muted-foreground">
                        Simulate live team Slack commands to query project health, daily standups, and AI recommendations.
                      </p>
                    </div>
                  </div>
                  <span className="px-2.5 py-1 rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 text-xs font-mono">
                    #agency-bot connected
                  </span>
                </div>

                {/* Command Bar */}
                <div className="flex flex-col sm:flex-row gap-2">
                  <select
                    value={slackCmd}
                    onChange={e => setSlackCmd(e.target.value)}
                    className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none shrink-0"
                  >
                    <option value="/status">/status (Team Status Summary)</option>
                    <option value="/standup">/standup (Process Standup Inquiry)</option>
                    <option value="/ask">/ask (Query AI Agency Assistant)</option>
                  </select>
                  <input
                    value={slackText}
                    onChange={e => setSlackText(e.target.value)}
                    placeholder={slackCmd === "/status" ? "Optional note (e.g. Focus on MedTech project)" : "Type message or query..."}
                    className="flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/30"
                    onKeyDown={e => e.key === "Enter" && handleSendSlack()}
                  />
                  <Button onClick={handleSendSlack} disabled={sendingSlack}>
                    {sendingSlack ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                  </Button>
                </div>

                {/* Slack Console Output */}
                <div className="rounded-xl bg-slate-950 text-slate-100 p-4 font-mono text-xs space-y-4 min-h-[300px] max-h-[500px] overflow-y-auto">
                  <div className="text-slate-400 flex items-center gap-2 border-b border-slate-800 pb-2">
                    <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
                    KernelHub Slack Command Line Interface — Connected to DSQL Context
                  </div>

                  {slackLogs.length === 0 ? (
                    <div className="text-slate-500 py-8 text-center">
                      Select a slash command above (e.g., <code>/status</code>) and click Send to interact with the Slack bot.
                    </div>
                  ) : (
                    slackLogs.map((log, idx) => (
                      <div key={idx} className="space-y-1.5 border-b border-slate-800/60 pb-3">
                        <div className="flex items-center justify-between text-slate-400">
                          <span className="text-emerald-400">User &gt; {log.cmd}</span>
                          <span className="text-[10px]">{log.time}</span>
                        </div>
                        <div className="text-slate-200 leading-relaxed whitespace-pre-wrap pl-2 border-l-2 border-primary/60">
                          {log.resp}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          )}

        </div>
      </div>

      {/* ── Modal: Add Client Project ── */}
      {showAddProject && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4" onClick={() => setShowAddProject(false)}>
          <div className="bg-card border border-border rounded-xl p-6 w-full max-w-lg shadow-2xl space-y-4" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-border/40 pb-3">
              <h2 className="font-semibold text-base">Create New Client Project</h2>
              <button onClick={() => setShowAddProject(false)}><X className="h-4 w-4 text-muted-foreground" /></button>
            </div>

            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Project Title *</label>
              <input
                value={projectForm.title}
                onChange={e => setProjectForm(f => ({ ...f, title: e.target.value }))}
                placeholder="e.g. Healthcare Patient Portal Website"
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block">Project Type</label>
                <select
                  value={projectForm.project_type}
                  onChange={e => setProjectForm(f => ({ ...f, project_type: e.target.value as AgencyProject["project_type"] }))}
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none"
                >
                  <option value="website">Website / Portal</option>
                  <option value="ai_agent">AI Agent Squad</option>
                  <option value="chatbot">Custom Chatbot</option>
                  <option value="automation">Workflow Automation</option>
                  <option value="mobile_app">Mobile App</option>
                </select>
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block">Assigned Developer</label>
                <select
                  value={projectForm.assigned_employee_id}
                  onChange={e => setProjectForm(f => ({ ...f, assigned_employee_id: e.target.value }))}
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none"
                >
                  <option value="">Unassigned</option>
                  {employees.map(emp => (
                    <option key={emp.id} value={emp.id}>{emp.name} ({emp.role})</option>
                  ))}
                </select>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block">Budget ($)</label>
                <input
                  type="number"
                  value={projectForm.budget}
                  onChange={e => setProjectForm(f => ({ ...f, budget: Number(e.target.value) }))}
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none"
                />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block">Deadline</label>
                <input
                  type="date"
                  value={projectForm.deadline}
                  onChange={e => setProjectForm(f => ({ ...f, deadline: e.target.value }))}
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none"
                />
              </div>
            </div>

            <div className="flex gap-2 pt-2">
              <Button variant="outline" size="sm" className="flex-1" onClick={() => setShowAddProject(false)}>Cancel</Button>
              <Button size="sm" className="flex-1" onClick={handleCreateProject} disabled={!projectForm.title.trim()}>
                Create Project
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* ── Modal: Add Employee ── */}
      {showAddEmployee && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4" onClick={() => setShowAddEmployee(false)}>
          <div className="bg-card border border-border rounded-xl p-6 w-full max-w-md shadow-2xl space-y-4" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-border/40 pb-3">
              <h2 className="font-semibold text-base">Add Agency Developer / Employee</h2>
              <button onClick={() => setShowAddEmployee(false)}><X className="h-4 w-4 text-muted-foreground" /></button>
            </div>

            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Employee Name *</label>
              <input
                value={employeeForm.name}
                onChange={e => setEmployeeForm(f => ({ ...f, name: e.target.value }))}
                placeholder="Alex Mercer"
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block">Role</label>
                <input
                  value={employeeForm.role}
                  onChange={e => setEmployeeForm(f => ({ ...f, role: e.target.value }))}
                  placeholder="AI Engineer"
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none"
                />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block">Slack Handle</label>
                <input
                  value={employeeForm.slack_handle}
                  onChange={e => setEmployeeForm(f => ({ ...f, slack_handle: e.target.value }))}
                  placeholder="@alex"
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none"
                />
              </div>
            </div>

            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Skills</label>
              <input
                value={employeeForm.skills}
                onChange={e => setEmployeeForm(f => ({ ...f, skills: e.target.value }))}
                placeholder="React, Python, LangChain, PostgreSQL"
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none"
              />
            </div>

            <div className="flex gap-2 pt-2">
              <Button variant="outline" size="sm" className="flex-1" onClick={() => setShowAddEmployee(false)}>Cancel</Button>
              <Button size="sm" className="flex-1" onClick={handleCreateEmployee} disabled={!employeeForm.name.trim()}>
                Add Member
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* ── Modal: Add Client ── */}
      {showAddClient && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4" onClick={() => setShowAddClient(false)}>
          <div className="bg-card border border-border rounded-xl p-6 w-full max-w-md shadow-2xl space-y-4" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-border/40 pb-3">
              <h2 className="font-semibold text-base">Add Client Company</h2>
              <button onClick={() => setShowAddClient(false)}><X className="h-4 w-4 text-muted-foreground" /></button>
            </div>

            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Company Name *</label>
              <input
                value={clientForm.company_name}
                onChange={e => setClientForm(f => ({ ...f, company_name: e.target.value }))}
                placeholder="Apex MedTech Inc."
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block">Contact Person</label>
                <input
                  value={clientForm.contact_person}
                  onChange={e => setClientForm(f => ({ ...f, contact_person: e.target.value }))}
                  placeholder="Sarah Connor"
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none"
                />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block">Industry</label>
                <input
                  value={clientForm.industry}
                  onChange={e => setClientForm(f => ({ ...f, industry: e.target.value }))}
                  placeholder="Healthcare"
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none"
                />
              </div>
            </div>

            <div className="flex gap-2 pt-2">
              <Button variant="outline" size="sm" className="flex-1" onClick={() => setShowAddClient(false)}>Cancel</Button>
              <Button size="sm" className="flex-1" onClick={handleCreateClient} disabled={!clientForm.company_name.trim()}>
                Save Client
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* ── Modal: Submit Standup ── */}
      {showStandupForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4" onClick={() => setShowStandupForm(false)}>
          <div className="bg-card border border-border rounded-xl p-6 w-full max-w-lg shadow-2xl space-y-4" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-border/40 pb-3">
              <h2 className="font-semibold text-base">Submit Daily Developer Standup</h2>
              <button onClick={() => setShowStandupForm(false)}><X className="h-4 w-4 text-muted-foreground" /></button>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block">Developer Name *</label>
                <input
                  value={standupForm.employee_name}
                  onChange={e => setStandupForm(f => ({ ...f, employee_name: e.target.value }))}
                  placeholder="Alex Mercer"
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none"
                />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block">Project Title</label>
                <input
                  value={standupForm.project_title}
                  onChange={e => setStandupForm(f => ({ ...f, project_title: e.target.value }))}
                  placeholder="Healthcare Patient Portal"
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none"
                />
              </div>
            </div>

            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Tasks Completed Today *</label>
              <textarea
                value={standupForm.tasks_today}
                onChange={e => setStandupForm(f => ({ ...f, tasks_today: e.target.value }))}
                rows={3}
                placeholder="Implemented Supabase OAuth authentication and integrated Pinecone RAG vectors..."
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none resize-y"
              />
            </div>

            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Plan for Tomorrow</label>
              <input
                value={standupForm.plan_tomorrow}
                onChange={e => setStandupForm(f => ({ ...f, plan_tomorrow: e.target.value }))}
                placeholder="Connect Groq LLM API and test response streaming."
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none"
              />
            </div>

            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block text-amber-600 dark:text-amber-400">
                Blockers / Delay Risk (if any)
              </label>
              <input
                value={standupForm.blockers}
                onChange={e => setStandupForm(f => ({ ...f, blockers: e.target.value }))}
                placeholder="Waiting on client API keys for EHR integration..."
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none"
              />
            </div>

            <div className="flex gap-2 pt-2">
              <Button variant="outline" size="sm" className="flex-1" onClick={() => setShowStandupForm(false)}>Cancel</Button>
              <Button size="sm" className="flex-1" onClick={handleSubmitStandup} disabled={!standupForm.employee_name.trim() || !standupForm.tasks_today.trim()}>
                Submit & Analyze Risk
              </Button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
