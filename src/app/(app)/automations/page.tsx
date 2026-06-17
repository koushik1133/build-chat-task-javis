"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  Plus, Zap, Play, Pause, Trash2, Clock, ChevronRight,
  Loader2, Kanban, Info, CheckCircle2, AlertCircle, FlaskConical, CalendarClock, Plug,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { timeAgo, cn } from "@/lib/utils";

type Workflow = {
  id: string;
  name: string;
  trigger_event: string;
  action_type: string;
  kanban_label: string | null;
  action_config: string | null;
  last_result: string | null;
  schedule_time: string | null;
  schedule_timezone: string | null;
  schedule_days: string | null;
  status: "active" | "paused";
  last_run: string | null;
  run_count: number;
  created_at: string;
};

type Agent = { id: string; name: string; role?: string; status: string };

type Integrations = {
  slack_connected: boolean;
  slack_channel_name: string | null;
  email_connected: boolean;
  email_default_to: string | null;
  email_available: boolean;
};

type ActionConfig = {
  webhook_url?: string;
  url?: string;
  to?: string;
  subject?: string;
  message?: string;
  agent_id?: string;
  prompt?: string;
  deliver_via?: string[];
};

const TRIGGER_OPTIONS = [
  {
    value: "Scheduled (Daily)",
    label: "Scheduled (Daily)",
    scheduled: true,
    desc: "Runs every day at a set time — website notification, Slack, email, task, or agent.",
  },
  {
    value: "Kanban Card Moved",
    label: "Kanban Card Moved",
    kanban: true,
    desc: "Fires when a Kanban card with a matching label is approved or moved.",
  },
];

const ACTION_OPTIONS = [
  { value: "Send Slack Message", desc: "Posts to your connected Slack channel." },
  { value: "Send Email", desc: "Sends to your saved email address." },
  { value: "Send Notification", desc: "Bell icon alert on KernelHub — no setup needed." },
  { value: "Create Task", desc: "Adds a task to Tasks + bell notification when it runs." },
  { value: "Deploy Agent", desc: "AI runs a daily brief (Groq), saves output, sends to bell/email/Slack." },
];

const SCHEDULE_DAYS = [
  { value: "daily", label: "Every day" },
  { value: "weekdays", label: "Weekdays (Mon–Fri)" },
  { value: "mon", label: "Mondays only" },
  { value: "tue", label: "Tuesdays only" },
  { value: "wed", label: "Wednesdays only" },
  { value: "thu", label: "Thursdays only" },
  { value: "fri", label: "Fridays only" },
  { value: "sat", label: "Saturdays only" },
  { value: "sun", label: "Sundays only" },
];

const TIMEZONES = [
  { value: "America/New_York", label: "Eastern (US)" },
  { value: "America/Chicago", label: "Central (US)" },
  { value: "America/Denver", label: "Mountain (US)" },
  { value: "America/Los_Angeles", label: "Pacific (US)" },
  { value: "Europe/London", label: "London" },
  { value: "Europe/Paris", label: "Paris / CET" },
  { value: "Asia/Kolkata", label: "India (IST)" },
  { value: "Asia/Tokyo", label: "Tokyo" },
  { value: "UTC", label: "UTC" },
];

const EMPTY_FORM = {
  name: "",
  trigger: "Scheduled (Daily)",
  action: "Send Notification",
  kanban_label: "",
  schedule_time: "06:00",
  schedule_timezone: "America/Chicago",
  schedule_days: "daily",
  action_config: {} as ActionConfig,
};

function parseLastResult(raw: string | null): { success?: boolean; message?: string } | null {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function formatScheduleTime(t: string | null): string {
  if (!t) return "—";
  const [h, m] = t.split(":").map(Number);
  const ampm = h >= 12 ? "PM" : "AM";
  const hour = h % 12 || 12;
  return `${hour}:${String(m).padStart(2, "0")} ${ampm}`;
}

function scheduleDaysLabel(days: string | null): string {
  return SCHEDULE_DAYS.find(d => d.value === (days ?? "daily"))?.label ?? "Every day";
}

export default function AutomationsPage() {
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [saving, setSaving] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [integrations, setIntegrations] = useState<Integrations | null>(null);

  useEffect(() => {
    fetch("/api/automations").then(r => r.json()).then(d => setWorkflows(d.workflows ?? [])).catch(() => {});
    fetch("/api/agents").then(r => r.json()).then(d => setAgents(d.agents ?? [])).catch(() => {});
    fetch("/api/integrations").then(r => r.json()).then(d => setIntegrations(d.integrations ?? null)).catch(() => {});
  }, []);

  const selectedTrigger = TRIGGER_OPTIONS.find(t => t.value === form.trigger)!;
  const selectedAction = ACTION_OPTIONS.find(a => a.value === form.action)!;
  const isScheduled = !!selectedTrigger.scheduled;

  function setConfig(patch: Partial<ActionConfig>) {
    setForm(f => ({ ...f, action_config: { ...f.action_config, ...patch } }));
  }

  function configValid(): boolean {
    switch (form.action) {
      case "Send Slack Message":
        return !!integrations?.slack_connected || !!form.action_config.webhook_url?.trim();
      case "Send Email":
        return (!!integrations?.email_connected && integrations.email_available)
          || !!form.action_config.to?.trim();
      case "Deploy Agent": return !!form.action_config.agent_id?.trim();
      default: return true;
    }
  }

  function needsConnection(): boolean {
    if (form.action === "Send Slack Message") return !integrations?.slack_connected;
    if (form.action === "Send Email") return !integrations?.email_connected || !integrations?.email_available;
    return false;
  }

  function triggerValid(): boolean {
    if (selectedTrigger.kanban) return !!form.kanban_label.trim();
    if (selectedTrigger.scheduled) return !!form.schedule_time;
    return true;
  }

  async function create() {
    if (!form.name.trim() || !configValid() || !triggerValid()) return;
    setSaving(true);
    setCreateError(null);
    const res = await fetch("/api/automations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: form.name,
        trigger: form.trigger,
        action: form.action,
        kanban_label: form.kanban_label.trim(),
        schedule_time: isScheduled ? form.schedule_time : undefined,
        schedule_timezone: isScheduled ? form.schedule_timezone : undefined,
        schedule_days: isScheduled ? form.schedule_days : undefined,
        action_config: form.action_config,
      }),
    }).then(r => r.json()).catch(() => null);
    if (res?.workflow) {
      setWorkflows(w => [res.workflow, ...w]);
      setForm(EMPTY_FORM);
      setShowCreate(false);
    } else {
      setCreateError(res?.db_error ?? res?.detail ?? res?.error ?? "Could not save workflow");
    }
    setSaving(false);
  }

  async function toggle(id: string, current: string) {
    const next = current === "active" ? "paused" : "active";
    await fetch(`/api/automations/${id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: next }),
    });
    setWorkflows(w => w.map(wf => wf.id === id ? { ...wf, status: next as Workflow["status"] } : wf));
  }

  async function remove(id: string) {
    await fetch(`/api/automations/${id}`, { method: "DELETE" });
    setWorkflows(w => w.filter(wf => wf.id !== id));
  }

  async function testRun(id: string) {
    const wf = workflows.find(w => w.id === id);
    const res = await fetch(`/api/automations/${id}/test`, { method: "POST" }).then(r => r.json()).catch(() => null);
    if (res?.result) {
      setWorkflows(list => list.map(w => w.id === id ? { ...w, last_result: JSON.stringify(res.result), run_count: w.run_count + 1, last_run: new Date().toISOString() } : w));
      if (res.result.success && (
        wf?.action_type === "Send Notification"
        || wf?.action_type === "Create Task"
        || wf?.action_type === "Deploy Agent"
      )) {
        const { dispatchNotificationRefresh } = await import("@/components/notification-bell");
        dispatchNotificationRefresh();
      }
    }
    return res?.result as { success: boolean; message: string; detail?: string } | undefined;
  }

  return (
    <div className="h-full overflow-y-auto overflow-x-hidden px-4 py-5 sm:px-6 sm:py-7 lg:px-8 lg:py-8">
      <div className="mx-auto w-full max-w-4xl space-y-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">AI Automations</h1>
            <p className="mt-1 text-sm text-muted-foreground">Daily schedules, Kanban triggers, Slack, email, and in-app alerts.</p>
          </div>
          <Button size="sm" onClick={() => setShowCreate(true)}>
            <Plus className="h-3.5 w-3.5" /> Create Workflow
          </Button>
        </div>

        <div className="rounded-xl border border-primary/20 bg-primary/5 p-4 flex items-start gap-3">
          <Info className="h-4 w-4 text-primary shrink-0 mt-0.5" />
          <div className="text-xs text-foreground space-y-1.5 flex-1">
            <p className="font-semibold text-sm">Quick start</p>
            <p className="text-muted-foreground">
              <strong className="text-foreground">Step 1:</strong>{" "}
              <Link href="/settings/integrations" className="text-primary hover:underline inline-flex items-center gap-0.5">
                Connect Slack & email once <Plug className="h-3 w-3" />
              </Link>
              {" "}— no API keys for users.<br />
              <strong className="text-foreground">Step 2:</strong> Create a workflow below (notifications work instantly).<br />
              <strong className="text-foreground">Step 3 (schedules):</strong> With{" "}
              <code className="bg-secondary px-1 rounded">npm run dev</code>, the scheduler runs automatically every second — a workflow set for 3:45 fires at ~3:45:01 (email/Slack). Deploy Agent runs may take longer.
            </p>
          </div>
        </div>

        {showCreate && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4" onClick={() => setShowCreate(false)}>
            <div className="bg-card border border-border rounded-2xl p-6 w-full max-w-lg shadow-2xl max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
              <h2 className="font-semibold mb-1">New Workflow</h2>
              <p className="text-xs text-muted-foreground mb-5">Configure trigger, action, and connection details.</p>

              <div className="space-y-4">
                <Field label="Workflow Name">
                  <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                    placeholder={isScheduled ? "e.g. Daily 6 AM standup reminder" : "e.g. Slack alert on deploy approval"}
                    autoFocus className={inputCls} />
                </Field>

                <Field label="Trigger">
                  <select value={form.trigger} onChange={e => setForm(f => ({ ...f, trigger: e.target.value }))} className={inputCls}>
                    {TRIGGER_OPTIONS.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                  </select>
                  <Hint>{selectedTrigger.desc}</Hint>
                </Field>

                {isScheduled ? (
                  <div className="rounded-lg border border-primary/30 bg-primary/5 p-3 space-y-3">
                    <div className="flex items-center gap-1.5 text-xs font-semibold text-primary">
                      <CalendarClock className="h-3.5 w-3.5" /> Schedule
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <Field label="Time">
                        <input type="time" value={form.schedule_time}
                          onChange={e => setForm(f => ({ ...f, schedule_time: e.target.value }))}
                          className={inputCls} />
                      </Field>
                      <Field label="Timezone">
                        <select value={form.schedule_timezone}
                          onChange={e => setForm(f => ({ ...f, schedule_timezone: e.target.value }))}
                          className={inputCls}>
                          {TIMEZONES.map(tz => <option key={tz.value} value={tz.value}>{tz.label}</option>)}
                        </select>
                      </Field>
                    </div>
                    <Field label="Repeat">
                      <select value={form.schedule_days}
                        onChange={e => setForm(f => ({ ...f, schedule_days: e.target.value }))}
                        className={inputCls}>
                        {SCHEDULE_DAYS.map(d => <option key={d.value} value={d.value}>{d.label}</option>)}
                      </select>
                    </Field>
                    <Hint>Runs within ~1 second of the set time (e.g. 3:45 → email at 3:45:01). Pick your timezone carefully.</Hint>
                  </div>
                ) : (
                  <div className="rounded-lg border border-primary/30 bg-primary/5 p-3 space-y-2">
                    <div className="flex items-center gap-1.5 text-xs font-semibold text-primary">
                      <Kanban className="h-3.5 w-3.5" /> Kanban Watch Label
                    </div>
                    <input value={form.kanban_label} onChange={e => setForm(f => ({ ...f, kanban_label: e.target.value }))}
                      placeholder="e.g. notify-slack (must match card Automation Label)"
                      className={inputCls} />
                  </div>
                )}

                <Field label="Action">
                  <select value={form.action} onChange={e => setForm(f => ({ ...f, action: e.target.value, action_config: {} }))} className={inputCls}>
                    {ACTION_OPTIONS.map(a => <option key={a.value} value={a.value}>{a.value}</option>)}
                  </select>
                  <Hint>{selectedAction.desc}</Hint>
                </Field>

                <ActionConfigForm
                  action={form.action}
                  config={form.action_config}
                  agents={agents}
                  integrations={integrations}
                  onChange={setConfig}
                  isScheduled={isScheduled}
                />

                {needsConnection() && (
                  <div className="rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 p-3 text-xs">
                    <p className="font-medium text-amber-900 dark:text-amber-100 mb-1">Connection required</p>
                    <p className="text-amber-800 dark:text-amber-200 mb-2">
                      {form.action === "Send Slack Message"
                        ? "Connect Slack once in Settings — then all workflows use it automatically."
                        : "Add your email in Settings — KernelHub sends from your company AI address."}
                    </p>
                    <Link href="/settings/integrations">
                      <Button size="sm" variant="outline" className="h-7 text-xs">
                        <Plug className="h-3 w-3" /> Open Connections
                      </Button>
                    </Link>
                  </div>
                )}
              </div>

              {createError && (
                <p className="text-xs text-red-500 mt-4">{createError}</p>
              )}
              <div className="flex gap-2 mt-5">
                <Button variant="outline" size="sm" className="flex-1" onClick={() => { setShowCreate(false); setCreateError(null); }}>Cancel</Button>
                <Button size="sm" className="flex-1" onClick={create}
                  disabled={saving || !form.name.trim() || !triggerValid() || !configValid()}>
                  {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
                  Create
                </Button>
              </div>
            </div>
          </div>
        )}

        {workflows.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border p-12 text-center">
            <Zap className="h-8 w-8 text-primary mx-auto mb-3" />
            <p className="text-sm font-medium mb-1">No workflows yet</p>
            <p className="text-xs text-muted-foreground mb-4">Schedule daily alerts or connect Kanban cards to Slack and email.</p>
            <Button size="sm" onClick={() => setShowCreate(true)}><Plus className="h-3.5 w-3.5" /> Create First Workflow</Button>
          </div>
        ) : (
          <div className="space-y-2">
            {workflows.map(wf => (
              <WorkflowRow key={wf.id} wf={wf} onToggle={toggle} onRemove={remove} onTest={testRun} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ActionConfigForm({
  action, config, agents, onChange, isScheduled, integrations,
}: {
  action: string;
  config: ActionConfig;
  agents: Agent[];
  onChange: (p: Partial<ActionConfig>) => void;
  isScheduled?: boolean;
  integrations: Integrations | null;
}) {
  const vars = isScheduled
    ? "{{workflow}} {{date}} {{time}}"
    : "{{task_title}} {{from_column}} {{to_column}} {{label}} {{workflow}}";

  if (action === "Send Slack Message") {
    if (integrations?.slack_connected) {
      return (
        <div className="rounded-lg border border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-950/30 p-3 space-y-2">
          <p className="text-xs font-medium text-green-800 dark:text-green-200 flex items-center gap-1">
            <CheckCircle2 className="h-3.5 w-3.5" /> Using connected Slack
            {integrations.slack_channel_name && ` (${integrations.slack_channel_name})`}
          </p>
          <TemplateField config={config} onChange={onChange} vars={vars} />
          <Link href="/settings/integrations" className="text-[11px] text-primary hover:underline">Change Slack channel</Link>
        </div>
      );
    }
    return (
      <div className="rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 p-3 text-xs text-amber-800 dark:text-amber-200">
        Connect Slack in <Link href="/settings/integrations" className="text-primary hover:underline">Settings → Connections</Link> first.
      </div>
    );
  }

  if (action === "Send Email") {
    if (integrations?.email_connected && integrations.email_available) {
      return (
        <>
          <div className="rounded-lg border border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-950/30 p-3 mb-3">
            <p className="text-xs font-medium text-green-800 dark:text-green-200 flex items-center gap-1">
              <CheckCircle2 className="h-3.5 w-3.5" /> Sending to {integrations.email_default_to}
            </p>
          </div>
          <Field label="Subject (optional)">
            <input value={config.subject ?? ""} onChange={e => onChange({ subject: e.target.value })}
              placeholder={isScheduled ? "KernelHub daily: {{workflow}}" : "KernelHub: {{workflow}} — {{task_title}}"}
              className={inputCls} />
          </Field>
          <TemplateField config={config} onChange={onChange} vars={vars} />
          <Field label="Override recipient (optional)">
            <input type="email" value={config.to ?? ""} onChange={e => onChange({ to: e.target.value })}
              placeholder="Leave blank to use your saved email"
              className={inputCls} />
          </Field>
        </>
      );
    }
    return (
      <div className="rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 p-3 text-xs text-amber-800 dark:text-amber-200">
        {!integrations?.email_available
          ? "Email will be enabled by your KernelHub admin. Then add your address in Settings → Connections."
          : <>Add your email in <Link href="/settings/integrations" className="text-primary hover:underline">Settings → Connections</Link>.</>}
      </div>
    );
  }

  if (action === "Send Notification") {
    return (
      <TemplateField
        config={config}
        onChange={onChange}
        label="Notification message (optional)"
        placeholder={isScheduled ? "Daily reminder: {{workflow}}" : "*{{workflow}}* fired for {{task_title}}"}
        vars={vars}
      />
    );
  }

  if (action === "Create Task") {
    return (
      <Field label="Task title template">
        <input value={config.message ?? ""} onChange={e => onChange({ message: e.target.value })}
          placeholder={isScheduled ? "Daily standup: {{workflow}}" : "Follow up: {{task_title}}"}
          className={inputCls} />
        <Hint>
          {isScheduled
            ? "Leave blank for default: Daily: {{workflow}} — {{date}}. Check Tasks after it runs."
            : `Variables: ${vars}`}
        </Hint>
      </Field>
    );
  }

  if (action === "Deploy Agent") {
    if (agents.length === 0) {
      return (
        <div className="rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 p-3 text-xs text-amber-800 dark:text-amber-200">
          No agents yet.{" "}
          <Link href="/agents" className="text-primary hover:underline">Create an agent in AI Agents</Link> first, then come back.
        </div>
      );
    }
    const deliver = config.deliver_via ?? ["notification"];
    function toggleDeliver(channel: string) {
      const next = deliver.includes(channel)
        ? deliver.filter(c => c !== channel)
        : [...deliver, channel];
      onChange({ deliver_via: next.length ? next : ["notification"] });
    }
    return (
      <>
        <Field label="Agent">
          <select value={config.agent_id ?? ""} onChange={e => onChange({ agent_id: e.target.value })} className={inputCls}>
            <option value="">Select agent…</option>
            {agents.map(a => <option key={a.id} value={a.id}>{a.name}{a.role ? ` — ${a.role}` : ""} ({a.status})</option>)}
          </select>
        </Field>
        <Field label="Instructions for the agent (optional)">
          <textarea value={config.prompt ?? ""} onChange={e => onChange({ prompt: e.target.value })}
            placeholder={isScheduled ? "Summarize today's priorities for my trailer business…" : "What should this agent do?"}
            rows={3} className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none resize-none focus:ring-2 focus:ring-primary/30" />
        </Field>
        <Field label="Send output to">
          <div className="flex flex-wrap gap-3 text-xs">
            {(["notification", "email", "slack"] as const).map(ch => (
              <label key={ch} className="flex items-center gap-1.5 cursor-pointer">
                <input type="checkbox" checked={deliver.includes(ch)} onChange={() => toggleDeliver(ch)} />
                {ch === "notification" ? "Website bell" : ch === "email" ? "Email" : "Slack"}
              </label>
            ))}
          </div>
          <Hint>Full report is saved in AI Agents → Run history. Slack is one-way (no replies yet).</Hint>
        </Field>
      </>
    );
  }

  return null;
}

function TemplateField({ config, onChange, label = "Custom message (optional)", placeholder, vars }: {
  config: ActionConfig;
  onChange: (p: Partial<ActionConfig>) => void;
  label?: string;
  placeholder?: string;
  vars?: string;
}) {
  return (
    <Field label={label}>
      <textarea value={config.message ?? ""} onChange={e => onChange({ message: e.target.value })}
        placeholder={placeholder ?? "*{{workflow}}* fired for {{task_title}}"}
        rows={2} className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none resize-none focus:ring-2 focus:ring-primary/30" />
      {vars && <Hint>Variables: {vars}</Hint>}
    </Field>
  );
}

function WorkflowRow({
  wf, onToggle, onRemove, onTest,
}: {
  wf: Workflow;
  onToggle: (id: string, status: string) => void;
  onRemove: (id: string) => void;
  onTest: (id: string) => Promise<{ success: boolean; message: string; detail?: string } | undefined>;
}) {
  const [testing, setTesting] = useState(false);
  const [testMsg, setTestMsg] = useState<string | null>(null);
  const last = parseLastResult(wf.last_result);
  const isScheduled = wf.trigger_event === "Scheduled (Daily)";

  async function handleTest() {
    setTesting(true);
    setTestMsg(null);
    const r = await onTest(wf.id);
    setTestMsg(r ? (r.success ? `✓ ${r.message}` : `✗ ${r.detail ?? r.message}`) : "Test failed");
    setTesting(false);
  }

  const tzLabel = TIMEZONES.find(t => t.value === wf.schedule_timezone)?.label ?? wf.schedule_timezone;

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-start gap-4">
        <div className="flex items-center gap-2 flex-1 min-w-0 flex-wrap">
          <div className="shrink-0">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">Trigger</div>
            <div className="rounded-lg border border-primary/30 bg-primary/5 px-2.5 py-1.5 text-xs font-medium text-primary flex items-center gap-1">
              {isScheduled ? <CalendarClock className="h-3 w-3" /> : <Kanban className="h-3 w-3" />}
              {wf.trigger_event}
            </div>
            {isScheduled ? (
              <div className="mt-1 text-[10px] text-muted-foreground">
                {formatScheduleTime(wf.schedule_time)} · {tzLabel}<br />
                {scheduleDaysLabel(wf.schedule_days)}
              </div>
            ) : wf.kanban_label ? (
              <div className="mt-1 text-[10px] text-muted-foreground">
                label: <code className="bg-secondary rounded px-1 text-primary">{wf.kanban_label}</code>
              </div>
            ) : null}
          </div>
          <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
          <div className="shrink-0">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">Action</div>
            <div className="rounded-lg border border-border bg-secondary px-2.5 py-1.5 text-xs font-medium">{wf.action_type}</div>
          </div>
          <div className="flex-1 min-w-0 pl-2">
            <div className="font-medium text-sm">{wf.name}</div>
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground mt-0.5 flex-wrap">
              <Clock className="h-3 w-3" />
              {wf.last_run ? `Last run ${timeAgo(wf.last_run)}` : "Never run"}
              <span>·</span>{wf.run_count} runs
              {last && (
                <span className={cn("flex items-center gap-0.5", last.success ? "text-green-600" : "text-red-500")}>
                  {last.success ? <CheckCircle2 className="h-3 w-3" /> : <AlertCircle className="h-3 w-3" />}
                  {last.message}
                </span>
              )}
            </div>
            {testMsg && <p className="text-xs mt-1 text-muted-foreground">{testMsg}</p>}
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <span className={cn("text-[10px] font-medium rounded-full px-2 py-0.5 mr-1",
            wf.status === "active" ? "bg-green-50 text-green-700 dark:bg-green-950 dark:text-green-400" : "bg-secondary text-muted-foreground"
          )}>{wf.status}</span>
          <Button variant="outline" size="sm" onClick={handleTest} disabled={testing} title="Send test now">
            {testing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FlaskConical className="h-3.5 w-3.5" />}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => onToggle(wf.id, wf.status)}>
            {wf.status === "active" ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => onRemove(wf.id)}>
            <Trash2 className="h-3.5 w-3.5 text-destructive" />
          </Button>
        </div>
      </div>
    </div>
  );
}

const inputCls = "w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/30";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-xs font-medium text-muted-foreground mb-1 block">{label}</label>
      {children}
    </div>
  );
}

function Hint({ children }: { children: React.ReactNode }) {
  return <p className="text-[11px] text-muted-foreground mt-1">{children}</p>;
}
