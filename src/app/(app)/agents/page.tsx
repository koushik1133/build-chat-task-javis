"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Plus, Bot, Play, Pause, Trash2, CheckCircle2, Loader2,
  Sparkles, Pencil, ChevronLeft, ChevronRight, Zap, ShieldCheck, Store, Coins, FlaskConical,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { dispatchNotificationRefresh } from "@/components/notification-bell";
import { InfoTooltip } from "@/components/ui/info-tooltip";
import { PageContainer } from "@/components/page-container";
import { Dialog } from "@/components/ui/dialog";
import { Empty } from "@/components/ui/feedback";
import { SearchField } from "@/components/ui/search-field";
import { useDebouncedValue } from "@/components/ui/hooks";


type AgentTemplate = {
  id: string;
  name: string;
  role: string;
  emoji: string;
  desc: string;
  system_prompt: string;
  example_tasks: string[];
};

type Agent = {
  id: string;
  name: string;
  role: string;
  status: "active" | "paused" | "idle";
  tasks_completed: number;
  created_at: string;
  system_prompt?: string | null;
  template_id?: string | null;
  autonomy_level?: AutonomyLevel | null;
  outcome_event?: string | null;
  outcome_price_credits?: number | string | null;
};

type AutonomyLevel = "draft" | "approve" | "auto";

const AUTONOMY_OPTIONS: { id: AutonomyLevel; label: string; hint: string }[] = [
  { id: "draft", label: "Draft", hint: "Never acts — every write is queued for you" },
  { id: "approve", label: "Approve", hint: "Pauses for approval on sends/writes" },
  { id: "auto", label: "Auto", hint: "Runs end-to-end without asking" },
];

type TriggerSummary = { id: string; kind: string; cron_expr?: string | null; event_type?: string | null; enabled?: boolean | null };

type PlaybookRun = { id: string; entityId: string | null; runId: string | null; status: string; createdAt: string };
type Playbook = {
  id: string;
  name: string;
  description: string;
  cooldownHours: number;
  defaultTools: string[];
  enabled: boolean;
  recentRuns: PlaybookRun[];
};

const RUN_STATUS_STYLES: Record<string, string> = {
  done: "bg-green-50 text-green-700 dark:bg-green-950 dark:text-green-400",
  failed: "bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-400",
  awaiting_approval: "bg-yellow-50 text-yellow-700 dark:bg-yellow-950 dark:text-yellow-400",
};

const STATUS_STYLES: Record<string, string> = {
  active: "bg-green-50 text-green-700 dark:bg-green-950 dark:text-green-400",
  paused: "bg-yellow-50 text-yellow-700 dark:bg-yellow-950 dark:text-yellow-400",
  idle: "bg-secondary text-muted-foreground",
};

type AgentRun = {
  id: string;
  agent_id: string;
  agent_name: string;
  agent_role: string;
  workflow_name: string | null;
  output: string;
  created_at: string;
};

type DeployStep = "pick" | "configure";

type Correction = { id?: string; agent_id?: string };

export default function AgentsPage() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [templates, setTemplates] = useState<AgentTemplate[]>([]);
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [corrections, setCorrections] = useState<Correction[]>([]);
  const [expandedRun, setExpandedRun] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [deploying, setDeploying] = useState(false);
  const [showDeploy, setShowDeploy] = useState(false);
  const [deployStep, setDeployStep] = useState<DeployStep>("pick");
  const [selectedTemplate, setSelectedTemplate] = useState<AgentTemplate | null>(null);
  const [form, setForm] = useState({ name: "", system_prompt: "" });
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [suggesting, setSuggesting] = useState(false);

  const [editAgent, setEditAgent] = useState<Agent | null>(null);
  const [editForm, setEditForm] = useState({ name: "", system_prompt: "" });
  const [editSuggestions, setEditSuggestions] = useState<string[]>([]);
  const [editSuggesting, setEditSuggesting] = useState(false);
  const [saving, setSaving] = useState(false);

  const [confirmRunAgent, setConfirmRunAgent] = useState<Agent | null>(null);
  const [runningAgentId, setRunningAgentId] = useState<string | null>(null);

  const [correctingRun, setCorrectingRun] = useState<AgentRun | null>(null);
  const [correctionText, setCorrectionText] = useState("");
  const [savingCorrection, setSavingCorrection] = useState(false);

  const [playbooks, setPlaybooks] = useState<Playbook[]>([]);
  const [playbooksLoading, setPlaybooksLoading] = useState(true);
  const [playbooksError, setPlaybooksError] = useState<string | null>(null);
  const [playbookBusy, setPlaybookBusy] = useState<string | null>(null);
  const [playbookNotice, setPlaybookNotice] = useState<string | null>(null);
  /** agentId -> triggers; undefined = not loaded, [] = none or route missing */
  const [triggers, setTriggers] = useState<Record<string, TriggerSummary[]>>({});
  const [autonomySaving, setAutonomySaving] = useState<string | null>(null);

  const loadPlaybooks = useCallback(async () => {
    setPlaybooksLoading(true);
    setPlaybooksError(null);
    try {
      const res = await fetch("/api/agents/playbooks", { cache: "no-store" });
      if (!res.ok) throw new Error(`Failed to load playbooks (${res.status})`);
      const d = await res.json();
      setPlaybooks(d.playbooks ?? []);
    } catch (err) {
      setPlaybooksError(err instanceof Error ? err.message : "Failed to load playbooks");
    } finally {
      setPlaybooksLoading(false);
    }
  }, []);

  useEffect(() => {
    fetch("/api/agents").then(r => r.json()).then(d => setAgents(d.agents ?? [])).catch(() => {});
    fetch("/api/agents/runs").then(r => r.json()).then(d => setRuns(d.runs ?? [])).catch(() => {});
    fetch("/api/agents/templates").then(r => r.json()).then(d => setTemplates(d.templates ?? [])).catch(() => {});
    fetch("/api/agents/corrections").then(r => r.json()).then(d => setCorrections(d.corrections ?? [])).catch(() => {});
    loadPlaybooks();
  }, [loadPlaybooks]);

  // Triggers route is built by another lane; a 404 simply means "no summary yet".
  useEffect(() => {
    const missing = agents.filter(a => triggers[a.id] === undefined);
    if (missing.length === 0) return;
    let cancelled = false;
    (async () => {
      const entries = await Promise.all(missing.map(async (a) => {
        try {
          const res = await fetch(`/api/agents/${a.id}/triggers`, { cache: "no-store" });
          const none: TriggerSummary[] = [];
          if (!res.ok) return [a.id, none] as const;
          const d = await res.json();
          const list: TriggerSummary[] = Array.isArray(d.triggers) ? d.triggers : Array.isArray(d) ? d : none;
          return [a.id, list] as const;
        } catch {
          const none: TriggerSummary[] = [];
          return [a.id, none] as const;
        }
      }));
      if (cancelled) return;
      setTriggers(prev => {
        const next = { ...prev };
        for (const [id, list] of entries) next[id] = list;
        return next;
      });
    })();
    return () => { cancelled = true; };
  }, [agents, triggers]);

  async function setAutonomy(agent: Agent, level: AutonomyLevel) {
    const previous = agent.autonomy_level ?? "approve";
    setAutonomySaving(agent.id);
    setAgents(a => a.map(ag => ag.id === agent.id ? { ...ag, autonomy_level: level } : ag));
    try {
      const res = await fetch(`/api/agents/${agent.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ autonomy_level: level }),
      });
      if (!res.ok) throw new Error();
      const d = await res.json().catch(() => null);
      if (d?.agent && d.agent.autonomy_level !== undefined && d.agent.autonomy_level !== level) {
        // Server didn't persist the field (route may not support it yet); reflect what it has.
        setAgents(a => a.map(ag => ag.id === agent.id ? { ...ag, autonomy_level: d.agent.autonomy_level ?? previous } : ag));
      }
    } catch {
      setAgents(a => a.map(ag => ag.id === agent.id ? { ...ag, autonomy_level: previous } : ag));
    } finally {
      setAutonomySaving(null);
    }
  }

  async function togglePlaybook(pb: Playbook) {
    const next = !pb.enabled;
    setPlaybooks(list => list.map(p => p.id === pb.id ? { ...p, enabled: next } : p));
    const res = await fetch("/api/agents/playbooks", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: pb.id, enabled: next }),
    }).catch(() => null);
    if (!res?.ok) {
      setPlaybooks(list => list.map(p => p.id === pb.id ? { ...p, enabled: pb.enabled } : p));
      setPlaybookNotice(`Could not ${next ? "enable" : "disable"} ${pb.name}.`);
    }
  }

  async function runPlaybookNow(pb: Playbook) {
    setPlaybookBusy(pb.id);
    setPlaybookNotice(null);
    try {
      const res = await fetch("/api/agents/playbooks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: pb.id }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || `Run failed (${res.status})`);
      setPlaybookNotice(d.runId ? `${pb.name}: run queued.` : `${pb.name}: skipped (${d.skipped ?? "nothing to do"}).`);
      if (d.runId) {
        loadPlaybooks();
        fetch("/api/agents").then(r => r.json()).then(x => setAgents(x.agents ?? [])).catch(() => {});
      }
    } catch (err) {
      setPlaybookNotice(err instanceof Error ? err.message : "Run failed");
    } finally {
      setPlaybookBusy(null);
    }
  }

  function describeTriggers(list: TriggerSummary[] | undefined): string | null {
    if (!list || list.length === 0) return null;
    const active = list.filter(t => t.enabled !== false);
    if (active.length === 0) return "Triggers paused";
    const parts = active.slice(0, 3).map(t =>
      t.kind === "schedule" ? `schedule ${t.cron_expr ?? ""}`.trim()
      : t.kind === "event" ? `on ${t.event_type ?? "event"}`
      : t.kind
    );
    return parts.join(" · ") + (active.length > 3 ? ` +${active.length - 3}` : "");
  }

  function openDeploy() {
    setShowDeploy(true);
    setDeployStep("pick");
    setSelectedTemplate(null);
    setForm({ name: "", system_prompt: "" });
    setSuggestions([]);
  }

  function pickTemplate(t: AgentTemplate) {
    setSelectedTemplate(t);
    setForm({ name: "", system_prompt: t.system_prompt });
    setSuggestions([]);
    setDeployStep("configure");
  }

  async function fetchSuggestions(
    templateId: string | null,
    systemPrompt: string,
    setter: (s: string[]) => void,
    loadingSetter: (b: boolean) => void
  ) {
    loadingSetter(true);
    const res = await fetch("/api/agents/templates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ template_id: templateId, system_prompt: systemPrompt }),
    }).then(r => r.json()).catch(() => null);
    setter(res?.suggestions ?? []);
    loadingSetter(false);
  }

  async function deploy() {
    if (!form.name.trim() || !selectedTemplate) return;
    setDeploying(true);
    const res = await fetch("/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: form.name,
        role: selectedTemplate.role,
        template_id: selectedTemplate.id,
        system_prompt: form.system_prompt,
      }),
    }).then(r => r.json()).catch(() => null);
    if (res?.agent) setAgents(a => [res.agent, ...a]);
    setShowDeploy(false);
    setDeploying(false);
  }

  function openEdit(agent: Agent) {
    setEditAgent(agent);
    setEditForm({
      name: agent.name,
      system_prompt: agent.system_prompt ?? templates.find(t => t.role === agent.role)?.system_prompt ?? "",
    });
    setEditSuggestions([]);
  }

  async function saveEdit() {
    if (!editAgent) return;
    setSaving(true);
    const res = await fetch(`/api/agents/${editAgent.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: editForm.name, system_prompt: editForm.system_prompt }),
    }).then(r => r.json()).catch(() => null);
    if (res?.agent) {
      setAgents(a => a.map(ag => ag.id === editAgent.id ? { ...ag, ...res.agent } : ag));
    } else {
      setAgents(a => a.map(ag =>
        ag.id === editAgent.id
          ? { ...ag, name: editForm.name, system_prompt: editForm.system_prompt }
          : ag
      ));
    }
    setEditAgent(null);
    setSaving(false);
  }

  async function toggle(id: string, current: string) {
    const next = current === "active" ? "paused" : "active";
    await fetch(`/api/agents/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: next }),
    });
    setAgents(a => a.map(ag => ag.id === id ? { ...ag, status: next as Agent["status"] } : ag));
  }

  async function remove(id: string) {
    await fetch(`/api/agents/${id}`, { method: "DELETE" });
    setAgents(a => a.filter(ag => ag.id !== id));
  }

  async function triggerRun(agentId: string) {
    setRunningAgentId(agentId);
    try {
      const res = await fetch(`/api/agents/${agentId}/run`, {
        method: "POST",
      });
      const data = await res.json();
      if (data.success) {
        // Refresh agents (to update task count)
        const agentsRes = await fetch("/api/agents").then(r => r.json()).catch(() => null);
        if (agentsRes?.agents) setAgents(agentsRes.agents);

        // Refresh run history
        const runsRes = await fetch("/api/agents/runs").then(r => r.json()).catch(() => null);
        if (runsRes?.runs) setRuns(runsRes.runs);

        // Dispatch notification refresh to bell icon
        if (data.notification) {
          dispatchNotificationRefresh(data.notification);
        }
      } else {
        alert(data.error || "Failed to run agent.");
      }
    } catch (err) {
      console.error(err);
      alert("Error occurred while triggering agent run.");
    } finally {
      setRunningAgentId(null);
      setConfirmRunAgent(null);
    }
  }

  function openCorrection(run: AgentRun) {
    setCorrectingRun(run);
    setCorrectionText(run.output);
  }

  async function submitCorrection() {
    if (!correctingRun) return;
    setSavingCorrection(true);
    try {
      // Find the agent ID for this run, since run model might not have agent_id directly,
      // wait, `run` has `agent_name`. We can try finding it in `agents`.
      const res = await fetch("/api/agents/corrections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId: correctingRun.agent_id,
          originalText: correctingRun.output,
          correctedText: correctionText,
          context: correctingRun.workflow_name || "manual",
        }),
      });
      if (res.ok) {
        setCorrectingRun(null);
        fetch("/api/agents/corrections").then(r => r.json()).then(d => setCorrections(d.corrections ?? [])).catch(() => {});
        alert("Correction saved! The agent will use this feedback in future runs.");
      } else {
        alert("Failed to save correction.");
      }
    } catch (err) {
      console.error(err);
      alert("Error saving correction.");
    } finally {
      setSavingCorrection(false);
    }
  }

  const search = useDebouncedValue(query.trim().toLowerCase(), 200);
  const filtered = useMemo(
    () => agents.filter(a => a.name.toLowerCase().includes(search) || a.role.toLowerCase().includes(search)),
    [agents, search]
  );

  return (
    <PageContainer
      wide
      title="AI agents"
      description="Pick a pre-built agent, customise its system prompt, and deploy."
      tooltip="Set up AI workers that run tasks on a schedule or on demand — like a virtual employee that never sleeps."
      actions={
        <>
          <Button asChild variant="outline" touch>
            <Link href="/marketplace"><Store className="h-4 w-4" aria-hidden /> Marketplace</Link>
          </Button>
          <Button touch onClick={openDeploy}>
            <Plus className="h-4 w-4" aria-hidden /> Deploy new agent
          </Button>
        </>
      }
    >
      <div className="space-y-6">

        {/* Deploy modal */}
        {showDeploy && (
          <Dialog
            title={deployStep === "pick" ? "Choose an agent template" : `Deploy ${selectedTemplate?.name ?? "agent"}`}
            description={deployStep === "pick" ? "Pre-built roles with smart defaults — you can edit the system prompt next." : selectedTemplate?.desc}
            onClose={() => setShowDeploy(false)}
            size="lg"
          >
            <div>
              {deployStep === "pick" ? (
                <>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {templates.map(t => (
                      <button
                        key={t.id}
                        type="button"
                        onClick={() => pickTemplate(t)}
                        className="text-left rounded-xl border border-border p-4 hover:border-primary/50 hover:bg-primary/5 transition-colors"
                      >
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-lg" aria-hidden>{t.emoji}</span>
                          <span className="font-medium text-sm">{t.name}</span>
                        </div>
                        <p className="text-xs text-muted-foreground leading-relaxed">{t.desc}</p>
                      </button>
                    ))}
                  </div>
                </>
              ) : selectedTemplate && (
                <>
                  <button
                    type="button"
                    onClick={() => setDeployStep("pick")}
                    className="mb-3 inline-flex min-h-11 items-center gap-1 rounded text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-0"
                  >
                    <ChevronLeft className="h-3.5 w-3.5" /> Back to templates
                  </button>

                  <div className="space-y-3">
                    <div>
                      <label className="text-xs font-medium text-muted-foreground mb-1 block">Agent name</label>
                      <input
                        value={form.name}
                        onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                        placeholder={`e.g. My ${selectedTemplate.name}`}
                        className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/30"
                      />
                    </div>

                    <div>
                      <div className="flex items-center justify-between mb-1">
                        <label className="text-xs font-medium text-muted-foreground">System prompt</label>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 text-xs gap-1"
                          disabled={suggesting}
                          onClick={() => fetchSuggestions(selectedTemplate.id, form.system_prompt, setSuggestions, setSuggesting)}
                        >
                          {suggesting ? <Loader2 className="h-3 w-3 animate-spin motion-reduce:animate-none" aria-hidden /> : <Sparkles className="h-3 w-3" />}
                          AI suggest
                        </Button>
                      </div>
                      <textarea
                        value={form.system_prompt}
                        onChange={e => setForm(f => ({ ...f, system_prompt: e.target.value }))}
                        rows={6}
                        className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/30 resize-y font-mono leading-relaxed"
                      />
                      <p className="text-[10px] text-muted-foreground mt-1">
                        This tells the agent how to behave on every run (automations, scheduled jobs, etc.).
                      </p>
                    </div>

                    {suggestions.length > 0 && (
                      <div className="space-y-2">
                        <p className="text-xs font-medium text-muted-foreground">Suggested prompts — click to use</p>
                        {suggestions.map((s, i) => (
                          <button
                            key={i}
                            type="button"
                            onClick={() => setForm(f => ({ ...f, system_prompt: s }))}
                            className="w-full text-left rounded-lg border border-border/60 p-3 text-xs text-muted-foreground hover:border-primary/40 hover:bg-primary/5 transition-colors leading-relaxed"
                          >
                            {s}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="flex gap-2 mt-5">
                    <Button variant="outline" size="sm" className="flex-1" onClick={() => setShowDeploy(false)}>Cancel</Button>
                    <Button size="sm" className="flex-1" onClick={deploy} disabled={deploying || !form.name.trim()}>
                      {deploying ? <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden /> : <>Deploy <ChevronRight className="h-3.5 w-3.5" /></>}
                    </Button>
                  </div>
                </>
              )}
            </div>
          </Dialog>
        )}

        {/* Edit prompt modal */}
        {editAgent && (
          <Dialog title="Edit agent" description={editAgent.role} onClose={() => setEditAgent(null)} size="lg">
            <div>
              <div className="space-y-3">
                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-1 block">Agent name</label>
                  <input
                    value={editForm.name}
                    onChange={e => setEditForm(f => ({ ...f, name: e.target.value }))}
                    className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/30"
                  />
                </div>

                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="text-xs font-medium text-muted-foreground">System prompt</label>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 text-xs gap-1"
                      disabled={editSuggesting}
                      onClick={() => fetchSuggestions(
                        editAgent.template_id ?? null,
                        editForm.system_prompt,
                        setEditSuggestions,
                        setEditSuggesting
                      )}
                    >
                      {editSuggesting ? <Loader2 className="h-3 w-3 animate-spin motion-reduce:animate-none" aria-hidden /> : <Sparkles className="h-3 w-3" />}
                      AI suggest
                    </Button>
                  </div>
                  <textarea
                    value={editForm.system_prompt}
                    onChange={e => setEditForm(f => ({ ...f, system_prompt: e.target.value }))}
                    rows={6}
                    className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/30 resize-y font-mono leading-relaxed"
                  />
                </div>

                {editSuggestions.length > 0 && (
                  <div className="space-y-2">
                    <p className="text-xs font-medium text-muted-foreground">Suggested prompts — click to use</p>
                    {editSuggestions.map((s, i) => (
                      <button
                        key={i}
                        type="button"
                        onClick={() => setEditForm(f => ({ ...f, system_prompt: s }))}
                        className="w-full text-left rounded-lg border border-border/60 p-3 text-xs text-muted-foreground hover:border-primary/40 hover:bg-primary/5 transition-colors leading-relaxed"
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div className="flex gap-2 mt-5">
                <Button variant="outline" size="sm" className="flex-1" onClick={() => setEditAgent(null)}>Cancel</Button>
                <Button size="sm" className="flex-1" onClick={saveEdit} disabled={saving || !editForm.name.trim()}>
                  {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden /> : "Save changes"}
                </Button>
              </div>
            </div>
          </Dialog>
        )}

        {/* Search */}
        <SearchField value={query} onChange={setQuery} label="Search agents" placeholder="Search agents by name or role" />

        {/* Agent grid */}
        {filtered.length === 0 ? (
          <Empty
            icon={<Bot className="h-5 w-5" />}
            title={search ? "No agents match" : "No agents deployed"}
            text={search ? "Try a different name or role." : "Start with a template like Lead Generator — customise the prompt, then deploy."}
            action={
              search ? (
                <Button variant="outline" onClick={() => setQuery("")}>Clear search</Button>
              ) : (
                <Button onClick={openDeploy}>
                  <Plus className="h-4 w-4" aria-hidden /> Deploy your first agent
                </Button>
              )
            }
          />
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {filtered.map((agent) => {
              const tmpl = templates.find(t => t.id === agent.template_id || t.role === agent.role);
              return (
                <div key={agent.id} className="rounded-xl border border-border bg-card p-5">
                  <div className="flex items-start justify-between mb-3">
                    <div className="flex items-center gap-3">
                      <div className="h-9 w-9 rounded-lg bg-primary/10 flex items-center justify-center text-base">
                        {tmpl?.emoji ?? <Bot className="h-4 w-4 text-primary" />}
                      </div>
                      <div>
                        <div className="font-medium text-sm flex items-center gap-2">
                          {agent.name}
                          {(() => {
                            const count = corrections.filter(c => c.agent_id === agent.id).length;
                            return count > 0 ? (
                              <span className="inline-flex items-center gap-0.5 rounded bg-violet-500/10 px-1.5 py-0.5 text-[9px] font-medium text-violet-500 dark:bg-violet-500/20" title="AI has learned user corrections for this agent">
                                🧠 {count}
                              </span>
                            ) : null;
                          })()}
                        </div>
                        <div className="text-xs text-muted-foreground">{agent.role}</div>
                      </div>
                    </div>
                    <span className={`text-[10px] font-medium rounded-full px-2 py-0.5 capitalize ${STATUS_STYLES[agent.status]}`}>
                      {agent.status}
                    </span>
                  </div>
                  {agent.system_prompt && (
                    <p className="text-[11px] text-muted-foreground line-clamp-2 mb-3 leading-relaxed">
                      {agent.system_prompt}
                    </p>
                  )}
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground mb-2">
                    <span className="inline-flex items-center gap-1">
                      <CheckCircle2 className="h-3 w-3 text-primary" />
                      {agent.tasks_completed} tasks completed
                    </span>
                    {agent.outcome_event && Number(agent.outcome_price_credits) > 0 && (
                      <span className="inline-flex items-center gap-1" title="Outcome pricing: charged once per run in which this event fires">
                        <Coins className="h-3 w-3" aria-hidden />
                        <span className="sr-only">Outcome pricing: </span>
                        {Number(agent.outcome_price_credits).toLocaleString()} credits per {agent.outcome_event}
                      </span>
                    )}
                    <Link
                      href={`/agents/${agent.id}/evals`}
                      aria-label={`Evals and memory for ${agent.name}`}
                      className="inline-flex min-h-11 items-center gap-1 rounded underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-0"
                    >
                      <FlaskConical className="h-3 w-3" aria-hidden /> Evals &amp; memory
                    </Link>
                  </div>
                  <div className="mb-4 space-y-2">
                    <div className="flex items-center gap-2 text-xs">
                      <ShieldCheck className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                      <label htmlFor={`autonomy-${agent.id}`} className="text-muted-foreground">Autonomy</label>
                      <select
                        id={`autonomy-${agent.id}`}
                        aria-label={`Autonomy level for ${agent.name}`}
                        value={agent.autonomy_level ?? "approve"}
                        disabled={autonomySaving === agent.id}
                        onChange={e => setAutonomy(agent, e.target.value as AutonomyLevel)}
                        title={AUTONOMY_OPTIONS.find(o => o.id === (agent.autonomy_level ?? "approve"))?.hint}
                        className="rounded-md border border-border bg-background px-2 py-1 text-xs outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-60"
                      >
                        {AUTONOMY_OPTIONS.map(o => (
                          <option key={o.id} value={o.id}>{o.label}</option>
                        ))}
                      </select>
                    </div>
                    <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                      <Zap className="h-3.5 w-3.5 shrink-0" />
                      <span className="truncate">
                        {triggers[agent.id] === undefined
                          ? "Loading triggers…"
                          : describeTriggers(triggers[agent.id]) ?? "No triggers — runs on demand"}
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline" size="sm" className="flex-1 text-xs"
                      onClick={() => toggle(agent.id, agent.status)}
                    >
                      {agent.status === "active" ? (
                        <><Pause className="h-3.5 w-3.5" /> Pause</>
                      ) : (
                        <><Play className="h-3.5 w-3.5" /> Activate</>
                      )}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="flex-1 text-xs hover:bg-primary/5 border-primary/20 text-primary"
                      onClick={() => setConfirmRunAgent(agent)}
                    >
                      <Play className="h-3.5 w-3.5 fill-primary/10" /> Run
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => openEdit(agent)} title="Edit prompt">
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => remove(agent.id)}>
                      <Trash2 className="h-3.5 w-3.5 text-destructive" />
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Playbooks */}
        <section className="rounded-xl border border-border bg-card p-5 space-y-3" aria-labelledby="playbooks-heading">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 id="playbooks-heading" className="text-sm font-semibold flex items-center gap-2">
                <Zap className="h-4 w-4 text-primary" /> Playbooks
                <InfoTooltip text="Proactive checks that run on their own — stalled deals, unanswered messages, overdue cards — and hand the work to a dedicated agent. Anything risky still stops in Approvals." />
              </h2>
              <p className="text-xs text-muted-foreground mt-0.5">
                Always-on detectors. Turn one off to silence it, or run it now to check immediately.
              </p>
            </div>
            <Button variant="ghost" size="sm" onClick={loadPlaybooks} disabled={playbooksLoading} aria-label="Refresh playbooks">
              <Loader2 className={`h-3.5 w-3.5 ${playbooksLoading ? "animate-spin" : "opacity-0"}`} />
            </Button>
          </div>

          {playbookNotice && (
            <div role="status" className="rounded-lg border border-border bg-secondary/40 px-3 py-2 text-xs">
              {playbookNotice}
            </div>
          )}

          {playbooksLoading && playbooks.length === 0 ? (
            <div className="flex items-center gap-2 py-6 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden /> Loading playbooks…
            </div>
          ) : playbooksError ? (
            <div role="alert" className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-xs text-destructive flex items-center justify-between gap-3">
              <span>{playbooksError}</span>
              <Button size="sm" variant="outline" onClick={loadPlaybooks}>Retry</Button>
            </div>
          ) : playbooks.length === 0 ? (
            <p className="py-6 text-center text-xs text-muted-foreground">No playbooks available.</p>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {playbooks.map(pb => (
                <div key={pb.id} className={`rounded-lg border p-4 transition-colors ${pb.enabled ? "border-border" : "border-border/60 opacity-70"}`}>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-sm font-medium">{pb.name}</div>
                      <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">{pb.description}</p>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={pb.enabled}
                      aria-label={`${pb.enabled ? "Disable" : "Enable"} ${pb.name}`}
                      onClick={() => togglePlaybook(pb)}
                      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${pb.enabled ? "bg-primary" : "bg-secondary"}`}
                    >
                      <span className={`inline-block h-4 w-4 rounded-full bg-background shadow transition-transform ${pb.enabled ? "translate-x-4" : "translate-x-0.5"}`} />
                    </button>
                  </div>
                  <div className="mt-3 flex items-center justify-between gap-2">
                    <span className="text-[10px] text-muted-foreground">Cooldown {pb.cooldownHours}h · {pb.defaultTools.length} tools</span>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs"
                      disabled={playbookBusy === pb.id}
                      onClick={() => runPlaybookNow(pb)}
                    >
                      {playbookBusy === pb.id ? <Loader2 className="h-3 w-3 animate-spin motion-reduce:animate-none" aria-hidden /> : <Play className="h-3 w-3" />}
                      Run now
                    </Button>
                  </div>
                  {pb.recentRuns.length > 0 && (
                    <ul className="mt-3 space-y-1 border-t border-border/60 pt-2" aria-label={`Recent ${pb.name} outcomes`}>
                      {pb.recentRuns.map(r => (
                        <li key={r.id} className="flex items-center justify-between gap-2 text-[10px]">
                          <span className={`rounded-full px-1.5 py-0.5 font-medium capitalize ${RUN_STATUS_STYLES[r.status] ?? "bg-secondary text-muted-foreground"}`}>
                            {r.status.replace("_", " ")}
                          </span>
                          <span className="truncate text-muted-foreground">{r.entityId ? `entity ${r.entityId.slice(0, 8)}…` : "—"}</span>
                          <span className="shrink-0 text-muted-foreground">{new Date(r.createdAt).toLocaleString()}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Run history */}
        {runs.length > 0 && (
          <div className="rounded-xl border border-border bg-card p-5 space-y-3">
            <h2 className="text-sm font-semibold">Run history</h2>
            <p className="text-xs text-muted-foreground">Output from scheduled automations and Test runs — stored here permanently.</p>
            <div className="space-y-2 max-h-80 overflow-y-auto">
              {runs.map(run => (
                <div key={run.id} className="rounded-lg border border-border/60 p-3">
                  <button
                    type="button"
                    className="w-full text-left"
                    onClick={() => setExpandedRun(expandedRun === run.id ? null : run.id)}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-medium">{run.agent_name} — {run.workflow_name ?? "Manual"}</span>
                      <span className="text-[10px] text-muted-foreground shrink-0">
                        {new Date(run.created_at).toLocaleString()}
                      </span>
                    </div>
                  </button>
                  {expandedRun === run.id && (
                    <div className="mt-2 space-y-2">
                      <pre className="text-[11px] text-muted-foreground whitespace-pre-wrap font-sans leading-relaxed">
                        {run.output}
                      </pre>
                      <Button 
                        size="sm" 
                        variant="secondary" 
                        className="text-[10px] h-6 px-2"
                        onClick={() => openCorrection(run)}
                      >
                        <Pencil className="h-3 w-3 mr-1" /> Teach AI / Correct Output
                      </Button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {agents.length >= 2 && (
          <div className="rounded-xl border border-primary/20 bg-primary/5 p-4 flex items-center gap-3">
            <Bot className="h-5 w-5 text-primary shrink-0" />
            <div>
              <div className="text-sm font-medium">Multi-Agent Squad Ready</div>
              <div className="text-xs text-muted-foreground">
                Your {agents.filter(a => a.status === "active").length} active agents can now be grouped into high-performance squads.
              </div>
            </div>
          </div>
        )}

        {/* Confirmation and denial popup with right-side aligned action buttons */}
        {confirmRunAgent && (
          <Dialog title="Run this agent now?" onClose={() => setConfirmRunAgent(null)} size="sm">
            <div>
              <p className="text-sm text-muted-foreground mb-6 leading-relaxed">
                Are you sure you want to trigger a manual test run for agent <strong className="text-foreground font-semibold">{confirmRunAgent.name}</strong> ({confirmRunAgent.role})? This will start the agent job immediately.
              </p>
              <div className="flex justify-end gap-2.5">
                <Button variant="outline" size="sm" onClick={() => setConfirmRunAgent(null)}>
                  Cancel
                </Button>
                <Button
                  size="sm"
                  onClick={() => triggerRun(confirmRunAgent.id)}
                  disabled={runningAgentId !== null}
                >
                  {runningAgentId === confirmRunAgent.id ? (
                    <><Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden /> Running…</>
                  ) : (
                    "Run agent"
                  )}
                </Button>
              </div>
            </div>
          </Dialog>
        )}

        {/* Correction modal */}
        {correctingRun && (
          <Dialog
            title="Correct agent output"
            description={`Teach the ${correctingRun.agent_name} agent how it should have responded. It will use this feedback in future runs.`}
            onClose={() => setCorrectingRun(null)}
            size="lg"
          >
            <div className="flex flex-col">
              <div className="space-y-4">
                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-1 block">What the agent did (Original)</label>
                  <div className="w-full rounded-lg border border-border/50 bg-secondary/30 px-3 py-2 text-xs text-muted-foreground whitespace-pre-wrap font-sans opacity-70">
                    {correctingRun.output}
                  </div>
                </div>

                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-1 block">What it should do instead (Correction)</label>
                  <textarea
                    value={correctionText}
                    onChange={e => setCorrectionText(e.target.value)}
                    rows={12}
                    className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/30 resize-none font-sans leading-relaxed"
                    placeholder="Edit the output to be exactly what you want..."
                  />
                </div>
              </div>

              <div className="flex gap-2 mt-5 shrink-0">
                <Button variant="outline" size="sm" className="flex-1" onClick={() => setCorrectingRun(null)}>Cancel</Button>
                <Button size="sm" className="flex-1" onClick={submitCorrection} disabled={savingCorrection || !correctionText.trim()}>
                  {savingCorrection ? <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden /> : "Save correction"}
                </Button>
              </div>
            </div>
          </Dialog>
        )}
      </div>
    </PageContainer>
  );
}
