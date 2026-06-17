"use client";

import { useEffect, useState } from "react";
import {
  Plus, Search, Bot, Play, Pause, Trash2, CheckCircle2, Loader2,
  Sparkles, Pencil, ChevronLeft, ChevronRight,
} from "lucide-react";
import { Button } from "@/components/ui/button";

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
};

const STATUS_STYLES: Record<string, string> = {
  active: "bg-green-50 text-green-700 dark:bg-green-950 dark:text-green-400",
  paused: "bg-yellow-50 text-yellow-700 dark:bg-yellow-950 dark:text-yellow-400",
  idle: "bg-secondary text-muted-foreground",
};

type AgentRun = {
  id: string;
  agent_name: string;
  agent_role: string;
  workflow_name: string | null;
  output: string;
  created_at: string;
};

type DeployStep = "pick" | "configure";

export default function AgentsPage() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [templates, setTemplates] = useState<AgentTemplate[]>([]);
  const [runs, setRuns] = useState<AgentRun[]>([]);
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

  useEffect(() => {
    fetch("/api/agents").then(r => r.json()).then(d => setAgents(d.agents ?? [])).catch(() => {});
    fetch("/api/agents/runs").then(r => r.json()).then(d => setRuns(d.runs ?? [])).catch(() => {});
    fetch("/api/agents/templates").then(r => r.json()).then(d => setTemplates(d.templates ?? [])).catch(() => {});
  }, []);

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

  const filtered = agents.filter(a =>
    a.name.toLowerCase().includes(query.toLowerCase()) ||
    a.role.toLowerCase().includes(query.toLowerCase())
  );

  return (
    <div className="h-full overflow-y-auto px-8 py-8">
      <div className="max-w-4xl mx-auto space-y-6">
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">AI Agents</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Pick a pre-built agent, customize its system prompt, and deploy.
            </p>
          </div>
          <Button size="sm" onClick={openDeploy}>
            <Plus className="h-3.5 w-3.5" /> Deploy New Agent
          </Button>
        </div>

        {/* Deploy modal */}
        {showDeploy && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4" onClick={() => setShowDeploy(false)}>
            <div
              className="bg-card border border-border rounded-xl p-6 w-full max-w-2xl shadow-2xl max-h-[90vh] overflow-y-auto"
              onClick={e => e.stopPropagation()}
            >
              {deployStep === "pick" ? (
                <>
                  <h2 className="font-semibold mb-1">Choose an agent template</h2>
                  <p className="text-xs text-muted-foreground mb-4">
                    Pre-built roles with smart defaults — you can edit the system prompt next.
                  </p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {templates.map(t => (
                      <button
                        key={t.id}
                        type="button"
                        onClick={() => pickTemplate(t)}
                        className="text-left rounded-xl border border-border p-4 hover:border-primary/50 hover:bg-primary/5 transition-colors"
                      >
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-lg">{t.emoji}</span>
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
                    className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground mb-3"
                  >
                    <ChevronLeft className="h-3.5 w-3.5" /> Back to templates
                  </button>
                  <div className="flex items-center gap-2 mb-4">
                    <span className="text-xl">{selectedTemplate.emoji}</span>
                    <div>
                      <h2 className="font-semibold">{selectedTemplate.name}</h2>
                      <p className="text-xs text-muted-foreground">{selectedTemplate.desc}</p>
                    </div>
                  </div>

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
                          {suggesting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
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
                      {deploying ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <>Deploy <ChevronRight className="h-3.5 w-3.5" /></>}
                    </Button>
                  </div>
                </>
              )}
            </div>
          </div>
        )}

        {/* Edit prompt modal */}
        {editAgent && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4" onClick={() => setEditAgent(null)}>
            <div
              className="bg-card border border-border rounded-xl p-6 w-full max-w-2xl shadow-2xl max-h-[90vh] overflow-y-auto"
              onClick={e => e.stopPropagation()}
            >
              <h2 className="font-semibold mb-1">Edit agent</h2>
              <p className="text-xs text-muted-foreground mb-4">{editAgent.role}</p>

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
                      {editSuggesting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
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
                  {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Save changes"}
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* Search */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search agents..."
            className="w-full rounded-lg border border-border bg-card pl-9 pr-4 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/30"
          />
        </div>

        {/* Agent grid */}
        {filtered.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border p-12 text-center">
            <Bot className="h-8 w-8 text-muted-foreground mx-auto mb-3" />
            <p className="text-sm font-medium mb-1">No agents deployed</p>
            <p className="text-xs text-muted-foreground mb-4">
              Start with a template like Lead Generator — customize the prompt, then deploy.
            </p>
            <Button size="sm" variant="outline" onClick={openDeploy}>
              <Plus className="h-3.5 w-3.5" /> Deploy your first agent
            </Button>
          </div>
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
                        <div className="font-medium text-sm">{agent.name}</div>
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
                  <div className="flex items-center gap-1 text-xs text-muted-foreground mb-4">
                    <CheckCircle2 className="h-3 w-3 text-primary" />
                    {agent.tasks_completed} tasks completed
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline" size="sm" className="flex-1"
                      onClick={() => toggle(agent.id, agent.status)}
                    >
                      {agent.status === "active" ? (
                        <><Pause className="h-3.5 w-3.5" /> Pause</>
                      ) : (
                        <><Play className="h-3.5 w-3.5" /> Activate</>
                      )}
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
                    <pre className="mt-2 text-[11px] text-muted-foreground whitespace-pre-wrap font-sans leading-relaxed">
                      {run.output}
                    </pre>
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
      </div>
    </div>
  );
}
