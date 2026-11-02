"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Brain, ChevronLeft, Coins, FlaskConical, Loader2, Play, Plus, RefreshCw, Save, Trash2 } from "lucide-react";
import { PageContainer } from "@/components/page-container";
import { Button } from "@/components/ui/button";
import { Dialog, DialogFooter } from "@/components/ui/dialog";
import { Banner, Empty, ErrorState, Loading, SkeletonList } from "@/components/ui/feedback";
import { Field } from "@/components/ui/field";
import { Input, Select, Textarea } from "@/components/ui/input";
import { Pill, type Tone } from "@/components/ui/pill";
import { TabPanel, Tabs } from "@/components/ui/tabs";
import { TableScroller, TH, THEAD } from "@/components/ui/table-scroller";
import { PASS_THRESHOLD, type CaseResult, type EvalCase, type ScoreSummary } from "@/lib/evals/score";
import { formatCredits } from "@/lib/credits/pricing";
import { cn } from "@/lib/utils";

/*
 * Agent detail for Phase 4: evaluation harness (cases → sandboxed runs →
 * LLM-judged scores), corrections-as-memory and outcome pricing.
 * Route: /agents/[id]/evals
 */

type Agent = { id: string; name: string; role: string };

interface RunSummary {
  id: string;
  status: "queued" | "running" | "done" | "failed";
  score: number | null;
  summary: ScoreSummary;
  model: string | null;
  cost_micros: number;
  error: string | null;
  created_at: string;
  finished_at: string | null;
}
interface RunDetail extends RunSummary {
  results: CaseResult[];
}
interface EvalItem {
  id: string;
  name: string;
  cases: EvalCase[];
  created_at: string;
  latest_run: RunSummary | null;
}
interface Correction {
  id: string;
  original: string;
  corrected: string;
  note: string | null;
  run_id: string | null;
  created_at: string;
}
interface Pricing {
  outcome_event: string | null;
  outcome_price_credits: number | null;
  event_types: readonly string[];
}

type Tab = "evals" | "corrections" | "pricing";
const TABS: ReadonlyArray<{ id: Tab; label: string }> = [
  { id: "evals", label: "Evals" },
  { id: "corrections", label: "Corrections" },
  { id: "pricing", label: "Outcome pricing" },
];

const RUN_TONE: Record<string, Tone> = { queued: "neutral", running: "info", done: "success", failed: "danger" };
const fmtDate = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "—");
const fmtUsd = (micros: number) => new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 4 }).format((micros || 0) / 1e6);

function scoreTone(score: number | null): Tone {
  if (score === null) return "neutral";
  return score >= PASS_THRESHOLD ? "success" : score >= 40 ? "warning" : "danger";
}

async function readJson(res: Response) {
  return res.json().catch(() => null);
}

export default function AgentEvalsPage() {
  const { id: agentId } = useParams<{ id: string }>();
  const [tab, setTab] = useState<Tab>("evals");
  const [agent, setAgent] = useState<Agent | null>(null);
  const [agentError, setAgentError] = useState<string | null>(null);
  const [loadingAgent, setLoadingAgent] = useState(true);

  const loadAgent = useCallback(async () => {
    setLoadingAgent(true);
    setAgentError(null);
    try {
      const res = await fetch(`/api/agents/${agentId}`, { cache: "no-store" });
      const data = await readJson(res);
      if (!res.ok) throw new Error(res.status === 404 ? "Agent not found." : data?.error ?? "Could not load agent.");
      setAgent({ id: String(data.agent.id), name: String(data.agent.name ?? "Agent"), role: String(data.agent.role ?? "") });
    } catch (err) {
      setAgentError(err instanceof Error ? err.message : "Could not load agent.");
    } finally {
      setLoadingAgent(false);
    }
  }, [agentId]);

  useEffect(() => {
    void loadAgent();
  }, [loadAgent]);

  return (
    <PageContainer
      wide
      eyebrow={
        <Link href="/agents" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ChevronLeft className="h-4 w-4" aria-hidden /> All agents
        </Link>
      }
      icon={<FlaskConical className="h-5 w-5" aria-hidden />}
      title={agent ? `${agent.name} · Evals & memory` : "Agent evals & memory"}
      description={agent?.role ? `${agent.role}. Test the agent against fixed cases, review what you have corrected, and price its outcomes.` : "Test the agent against fixed cases, review corrections, and price outcomes."}
      tooltip="Evals run the agent in a sandbox: read tools run for real, writes are simulated. A judge model scores each case 0–100."
    >
      {loadingAgent && !agent && <Loading label="Loading agent…" />}
      {agentError && !agent && <ErrorState message={agentError} onRetry={() => void loadAgent()} />}

      {agent && (
        <>
          <Tabs id="agent-detail" tabs={TABS} value={tab} onChange={setTab} label="Agent sections" className="mb-5" />
          {tab === "evals" && (
            <TabPanel id="agent-detail" value="evals">
              <EvalsPanel agentId={agent.id} />
            </TabPanel>
          )}
          {tab === "corrections" && (
            <TabPanel id="agent-detail" value="corrections">
              <CorrectionsPanel agentId={agent.id} />
            </TabPanel>
          )}
          {tab === "pricing" && (
            <TabPanel id="agent-detail" value="pricing">
              <PricingPanel agentId={agent.id} />
            </TabPanel>
          )}
        </>
      )}
    </PageContainer>
  );
}

// ── Evals ────────────────────────────────────────────────────────────────────

function EvalsPanel({ agentId }: { agentId: string }) {
  const [evals, setEvals] = useState<EvalItem[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/agents/${agentId}/evals`, { cache: "no-store" });
      const data = await readJson(res);
      if (!res.ok) throw new Error(data?.error ?? "Could not load evals.");
      const list = (data.evals ?? []) as EvalItem[];
      setEvals(list);
      setSelectedId((cur) => cur && list.some((e) => e.id === cur) ? cur : list[0]?.id ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load evals.");
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  useEffect(() => {
    void load();
  }, [load]);

  const selected = useMemo(() => evals?.find((e) => e.id === selectedId) ?? null, [evals, selectedId]);

  return (
    <div className="space-y-4">
      {error && <Banner tone="error" onDismiss={() => setError(null)}>{error}</Banner>}
      {notice && <Banner tone="success" onDismiss={() => setNotice(null)}>{notice}</Banner>}

      {loading && !evals && <SkeletonList count={3} label="Loading evals…" />}

      {evals && evals.length === 0 && (
        <Empty
          icon={<FlaskConical className="h-5 w-5" />}
          title="No evals yet"
          text="Create an eval with a few representative tasks and expected outcomes, then run it whenever you change the prompt or tools."
          action={
            <Button touch onClick={() => setCreating(true)}>
              <Plus className="h-4 w-4" aria-hidden /> New eval
            </Button>
          }
        />
      )}

      {evals && evals.length > 0 && (
        <div className="grid gap-4 lg:grid-cols-[260px_minmax(0,1fr)]">
          <aside className="rounded-xl border border-border bg-card p-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <h2 className="text-sm font-semibold">Evals</h2>
              <Button size="sm" variant="outline" onClick={() => setCreating(true)} aria-label="New eval">
                <Plus className="h-4 w-4" aria-hidden /> New
              </Button>
            </div>
            <ul className="space-y-1" aria-label="Evals">
              {evals.map((e) => (
                <li key={e.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedId(e.id)}
                    aria-current={e.id === selectedId ? "true" : undefined}
                    className={cn(
                      "flex w-full min-h-11 items-center justify-between gap-2 rounded-md px-3 py-2 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-9",
                      e.id === selectedId ? "bg-primary/10 font-medium" : "hover:bg-secondary/60"
                    )}
                  >
                    <span className="min-w-0 truncate">{e.name}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {e.latest_run?.score != null ? <Pill tone={scoreTone(e.latest_run.score)}>{e.latest_run.score}</Pill> : `${e.cases.length} case${e.cases.length === 1 ? "" : "s"}`}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </aside>
          {selected ? (
            <EvalEditor
              key={selected.id}
              item={selected}
              onChanged={(msg) => {
                setNotice(msg);
                void load();
              }}
              onDeleted={() => {
                setSelectedId(null);
                setNotice("Eval deleted.");
                void load();
              }}
            />
          ) : (
            <Loading />
          )}
        </div>
      )}

      {creating && (
        <CreateEvalDialog
          agentId={agentId}
          onClose={() => setCreating(false)}
          onCreated={(ev) => {
            setCreating(false);
            setNotice(`Eval "${ev.name}" created.`);
            setEvals((cur) => [ev, ...(cur ?? [])]);
            setSelectedId(ev.id);
          }}
        />
      )}
    </div>
  );
}

function CreateEvalDialog({ agentId, onClose, onCreated }: { agentId: string; onClose: () => void; onCreated: (ev: EvalItem) => void }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      setError("Give the eval a name.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/agents/${agentId}/evals`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), cases: [{ input: "Describe what you would do first on a typical day.", expected: "A short, prioritised plan grounded in real data from the tools available." }] }),
      });
      const data = await readJson(res);
      if (!res.ok) throw new Error(data?.error ?? "Could not create eval.");
      onCreated(data.eval as EvalItem);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create eval.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog title="New eval" description="A named set of test cases for this agent." onClose={onClose} size="sm">
      <form onSubmit={submit} className="space-y-4">
        <Field label="Name" required error={error}>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Weekly brief regression" maxLength={120} autoFocus />
        </Field>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Plus className="h-4 w-4" aria-hidden />} Create
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

function EvalEditor({ item, onChanged, onDeleted }: { item: EvalItem; onChanged: (msg: string) => void; onDeleted: () => void }) {
  const [name, setName] = useState(item.name);
  const [cases, setCases] = useState<EvalCase[]>(item.cases.length > 0 ? item.cases : [{ input: "" }]);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState<"inline" | "queue" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [runsLoading, setRunsLoading] = useState(true);
  const [activeRunId, setActiveRunId] = useState<string | null>(item.latest_run?.id ?? null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const loadRuns = useCallback(async () => {
    setRunsLoading(true);
    try {
      const res = await fetch(`/api/evals/${item.id}`, { cache: "no-store" });
      const data = await readJson(res);
      if (!res.ok) throw new Error(data?.error ?? "Could not load runs.");
      setRuns((data.runs ?? []) as RunSummary[]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load runs.");
    } finally {
      setRunsLoading(false);
    }
  }, [item.id]);

  useEffect(() => {
    void loadRuns();
  }, [loadRuns]);

  function updateCase(idx: number, patch: Partial<EvalCase>) {
    setCases((cs) => cs.map((c, i) => (i === idx ? { ...c, ...patch } : c)));
    setDirty(true);
  }

  async function save(): Promise<boolean> {
    const cleaned = cases.map((c) => ({ input: c.input.trim(), expected: c.expected?.trim() || undefined, rubric: c.rubric?.trim() || undefined })).filter((c) => c.input);
    if (cleaned.length === 0) {
      setError("Add at least one case with an input.");
      return false;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/evals/${item.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim() || item.name, cases: cleaned }),
      });
      const data = await readJson(res);
      if (!res.ok) throw new Error(data?.error ?? "Could not save eval.");
      setDirty(false);
      onChanged("Eval saved.");
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save eval.");
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function run(mode: "inline" | "queue") {
    if (dirty && !(await save())) return;
    setRunning(mode);
    setError(null);
    try {
      const res = await fetch(`/api/evals/${item.id}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ inline: mode === "inline" }),
      });
      const data = await readJson(res);
      if (!res.ok) throw new Error(data?.error ?? "Could not run eval.");
      const r = data.run as RunSummary;
      setActiveRunId(r.id);
      onChanged(mode === "inline" ? `Eval finished: score ${r.score ?? "—"}.` : "Eval queued; the worker picks it up on its next tick.");
      await loadRuns();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not run eval.");
    } finally {
      setRunning(null);
    }
  }

  async function remove() {
    setConfirmDelete(false);
    try {
      const res = await fetch(`/api/evals/${item.id}`, { method: "DELETE" });
      if (!res.ok && res.status !== 204) throw new Error("Could not delete eval.");
      onDeleted();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete eval.");
    }
  }

  return (
    <div className="min-w-0 space-y-4">
      {error && <Banner tone="error" onDismiss={() => setError(null)}>{error}</Banner>}

      <section className="rounded-xl border border-border bg-card p-4 sm:p-5" aria-labelledby={`eval-${item.id}-heading`}>
        <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
          <Field label="Eval name" className="min-w-0 flex-1 sm:max-w-sm">
            <Input
              id={`eval-${item.id}-heading`}
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setDirty(true);
              }}
              maxLength={120}
            />
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" touch onClick={() => void save()} disabled={saving || !dirty}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Save className="h-4 w-4" aria-hidden />} Save
            </Button>
            <Button size="sm" touch onClick={() => void run("inline")} disabled={running !== null || saving} aria-label="Run eval now">
              {running === "inline" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Play className="h-4 w-4" aria-hidden />} Run now
            </Button>
            <Button variant="outline" size="sm" touch onClick={() => void run("queue")} disabled={running !== null || saving} aria-label="Queue eval for the worker">
              {running === "queue" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null} Queue
            </Button>
            <Button variant="ghost" size="sm" touch onClick={() => setConfirmDelete(true)} aria-label="Delete eval">
              <Trash2 className="h-4 w-4 text-destructive" aria-hidden />
            </Button>
          </div>
        </div>

        <h3 className="mb-2 text-sm font-semibold">Cases</h3>
        <p className="mb-3 text-xs text-muted-foreground">Each case is one task for the agent. Expected and rubric are optional but make scores far more meaningful.</p>
        <ol className="space-y-3" aria-label="Eval cases">
          {cases.map((c, idx) => (
            <li key={idx} className="rounded-lg border border-border p-3">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-xs font-medium text-muted-foreground">Case {idx + 1}</span>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => {
                    setCases((cs) => (cs.length === 1 ? [{ input: "" }] : cs.filter((_, i) => i !== idx)));
                    setDirty(true);
                  }}
                  aria-label={`Remove case ${idx + 1}`}
                >
                  <Trash2 className="h-4 w-4" aria-hidden />
                </Button>
              </div>
              <div className="grid gap-3 md:grid-cols-3">
                <Field label="Input" required>
                  <Textarea value={c.input} onChange={(e) => updateCase(idx, { input: e.target.value })} rows={3} maxLength={8000} placeholder="The task to give the agent" />
                </Field>
                <Field label="Expected">
                  <Textarea value={c.expected ?? ""} onChange={(e) => updateCase(idx, { expected: e.target.value })} rows={3} maxLength={8000} placeholder="What a good answer contains" />
                </Field>
                <Field label="Rubric">
                  <Textarea value={c.rubric ?? ""} onChange={(e) => updateCase(idx, { rubric: e.target.value })} rows={3} maxLength={4000} placeholder="How the judge should grade" />
                </Field>
              </div>
            </li>
          ))}
        </ol>
        <Button
          variant="outline"
          size="sm"
          touch
          className="mt-3"
          onClick={() => {
            setCases((cs) => [...cs, { input: "" }]);
            setDirty(true);
          }}
          disabled={cases.length >= 25}
        >
          <Plus className="h-4 w-4" aria-hidden /> Add case
        </Button>
      </section>

      <section className="rounded-xl border border-border bg-card p-4 sm:p-5" aria-labelledby={`runs-${item.id}`}>
        <div className="mb-3 flex items-center justify-between gap-2">
          <h3 id={`runs-${item.id}`} className="text-sm font-semibold">Runs</h3>
          <Button variant="ghost" size="sm" onClick={() => void loadRuns()} disabled={runsLoading} aria-label="Refresh runs">
            {runsLoading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <RefreshCw className="h-4 w-4" aria-hidden />}
          </Button>
        </div>
        {runsLoading && runs.length === 0 ? (
          <SkeletonList count={2} itemClassName="h-10" label="Loading runs…" />
        ) : runs.length === 0 ? (
          <Empty title="Not run yet" text="Run the eval to see per-case scores and transcripts." />
        ) : (
          <TableScroller label="Eval runs">
            <table className="w-full min-w-[520px] text-sm">
              <thead className={THEAD}>
                <tr>
                  <th className={TH}>Started</th>
                  <th className={TH}>Status</th>
                  <th className={cn(TH, "text-right")}>Score</th>
                  <th className={TH}>Passed</th>
                  <th className={TH}>Model</th>
                  <th className={cn(TH, "text-right")}>Cost</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {runs.map((r) => (
                  <tr
                    key={r.id}
                    className={cn("cursor-pointer hover:bg-secondary/40", r.id === activeRunId && "bg-primary/5")}
                    onClick={() => setActiveRunId(r.id)}
                  >
                    <td className="whitespace-nowrap px-3 py-2">
                      <button type="button" className="underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => setActiveRunId(r.id)} aria-label={`Open run from ${fmtDate(r.created_at)}`}>
                        {fmtDate(r.created_at)}
                      </button>
                    </td>
                    <td className="px-3 py-2"><Pill tone={RUN_TONE[r.status] ?? "neutral"}>{r.status}</Pill></td>
                    <td className="px-3 py-2 text-right tabular-nums">{r.score ?? "—"}</td>
                    <td className="px-3 py-2 tabular-nums text-muted-foreground">{r.summary.judged > 0 ? `${r.summary.passed}/${r.summary.judged}` : "—"}</td>
                    <td className="max-w-[160px] truncate px-3 py-2 font-mono text-xs text-muted-foreground">{r.model ?? "—"}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmtUsd(r.cost_micros)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroller>
        )}
      </section>

      {activeRunId && <RunResults key={activeRunId} runId={activeRunId} onRefreshRuns={loadRuns} />}

      {confirmDelete && (
        <Dialog title="Delete this eval?" description="Its runs and results are removed too. This cannot be undone." onClose={() => setConfirmDelete(false)} size="sm">
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDelete(false)}>Cancel</Button>
            <Button variant="destructive" onClick={() => void remove()}>Delete</Button>
          </DialogFooter>
        </Dialog>
      )}
    </div>
  );
}

function RunResults({ runId, onRefreshRuns }: { runId: string; onRefreshRuns: () => Promise<void> }) {
  const [run, setRun] = useState<RunDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/evals/runs/${runId}`, { cache: "no-store" });
      const data = await readJson(res);
      if (!res.ok) throw new Error(data?.error ?? "Could not load run.");
      const r = data.run as RunDetail;
      setRun(r);
      setError(null);
      if (r.status === "queued" || r.status === "running") {
        timer.current = setTimeout(() => void load(), 3000);
      } else {
        void onRefreshRuns();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load run.");
    }
  }, [runId, onRefreshRuns]);

  useEffect(() => {
    void load();
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [load]);

  if (error) return <ErrorState message={error} onRetry={() => void load()} />;
  if (!run) return <Loading label="Loading results…" />;

  const pending = run.status === "queued" || run.status === "running";

  return (
    <section className="rounded-xl border border-border bg-card p-4 sm:p-5" aria-labelledby={`results-${run.id}`}>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 id={`results-${run.id}`} className="text-sm font-semibold">Results · {fmtDate(run.created_at)}</h3>
          <p className="text-xs text-muted-foreground">
            {run.summary.judged} judged · {run.summary.passed} passed (≥ {PASS_THRESHOLD}) · {run.summary.errored} errored · {fmtUsd(run.cost_micros)}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {pending && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-hidden />}
          <Pill tone={RUN_TONE[run.status]}>{run.status}</Pill>
          {run.score !== null && <span className={cn("rounded-full px-3 py-1 text-lg font-semibold tabular-nums", run.score >= PASS_THRESHOLD ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300" : "bg-red-500/15 text-red-700 dark:text-red-300")} aria-label={`Overall score ${run.score}`}>{run.score}</span>}
        </div>
      </div>

      {run.error && <Banner tone="error">{run.error}</Banner>}
      {pending && run.results.length === 0 && (
        <p className="text-sm text-muted-foreground" role="status" aria-live="polite">
          {run.status === "queued" ? "Waiting for the worker to pick this run up…" : "Running cases…"}
        </p>
      )}

      <ol className="space-y-3" aria-label="Case results">
        {run.results.map((r) => (
          <li key={r.idx} className="rounded-lg border border-border p-3">
            <div className="mb-2 flex flex-wrap items-start justify-between gap-2">
              <p className="min-w-0 flex-1 text-sm font-medium [overflow-wrap:anywhere]">
                <span className="text-muted-foreground">Case {r.idx + 1}:</span> {r.input}
              </p>
              <Pill tone={scoreTone(r.score)} className="text-sm">{r.score ?? "no score"}</Pill>
            </div>
            {r.reasons && <p className="mb-2 text-sm text-muted-foreground [overflow-wrap:anywhere]">{r.reasons}</p>}
            {r.error && <p className="mb-2 text-sm text-red-700 dark:text-red-300 [overflow-wrap:anywhere]">{r.error}</p>}
            <details className="group">
              <summary className="cursor-pointer text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                Output and transcript ({r.transcript.length} step{r.transcript.length === 1 ? "" : "s"}, {r.turns} turn{r.turns === 1 ? "" : "s"})
              </summary>
              <div className="mt-2 space-y-2">
                <div className="rounded-md bg-secondary/40 p-3 text-sm whitespace-pre-wrap [overflow-wrap:anywhere]">{r.output || "(no output)"}</div>
                {r.transcript.length > 0 && (
                  <ul className="space-y-1 text-xs">
                    {r.transcript.map((t, i) => (
                      <li key={i} className="rounded-md border border-border p-2 [overflow-wrap:anywhere]">
                        <span className={cn("mr-2 rounded px-1.5 py-0.5 font-medium", t.kind === "would_call" ? "bg-amber-500/15 text-amber-800 dark:text-amber-300" : t.kind === "tool" ? "bg-blue-500/15 text-blue-700 dark:text-blue-300" : "bg-secondary text-muted-foreground")}>
                          {t.kind === "would_call" ? "would call" : t.kind}
                        </span>
                        <span className="font-mono">{t.name}</span>
                        {t.input && <span className="text-muted-foreground"> · {t.input}</span>}
                        {t.output && <div className="mt-1 whitespace-pre-wrap text-muted-foreground">{t.output}</div>}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </details>
          </li>
        ))}
      </ol>
    </section>
  );
}

// ── Corrections ──────────────────────────────────────────────────────────────

function CorrectionsPanel({ agentId }: { agentId: string }) {
  const [items, setItems] = useState<Correction[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ original: "", corrected: "", note: "" });
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/agents/${agentId}/corrections`, { cache: "no-store" });
      const data = await readJson(res);
      if (!res.ok) throw new Error(data?.error ?? "Could not load corrections.");
      setItems((data.corrections ?? []) as Correction[]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load corrections.");
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.original.trim() || !form.corrected.trim()) {
      setError("Both the original and the corrected text are required.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/agents/${agentId}/corrections`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ original: form.original.trim(), corrected: form.corrected.trim(), note: form.note.trim() || null }),
      });
      const data = await readJson(res);
      if (!res.ok) throw new Error(data?.error ?? "Could not save correction.");
      setAdding(false);
      setForm({ original: "", corrected: "", note: "" });
      setNotice("Correction saved. The agent will see it on its next run.");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save correction.");
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    setDeleting(id);
    setError(null);
    try {
      const res = await fetch(`/api/agents/${agentId}/corrections?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!res.ok && res.status !== 204) throw new Error("Could not delete correction.");
      setItems((cur) => (cur ?? []).filter((c) => c.id !== id));
      setNotice("Correction removed.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete correction.");
    } finally {
      setDeleting(null);
    }
  }

  return (
    <div className="space-y-4">
      {error && <Banner tone="error" onDismiss={() => setError(null)}>{error}</Banner>}
      {notice && <Banner tone="success" onDismiss={() => setNotice(null)}>{notice}</Banner>}

      <section className="rounded-xl border border-border bg-card p-4 sm:p-5" aria-labelledby="corrections-heading">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 id="corrections-heading" className="flex items-center gap-2 text-sm font-semibold">
              <Brain className="h-4 w-4" aria-hidden /> Corrections the agent remembers
            </h2>
            <p className="text-xs text-muted-foreground">Captured automatically when you edit a proposed action before approving it; add your own too. The most relevant ones are injected into every run.</p>
          </div>
          <Button size="sm" touch onClick={() => setAdding(true)}>
            <Plus className="h-4 w-4" aria-hidden /> Add correction
          </Button>
        </div>

        {loading && !items && <SkeletonList count={3} label="Loading corrections…" />}
        {items && items.length === 0 && (
          <Empty icon={<Brain className="h-5 w-5" />} title="Nothing remembered yet" text="Edit an approval's payload before approving it, or add a correction by hand." />
        )}
        {items && items.length > 0 && (
          <ul className="divide-y divide-border" aria-label="Corrections">
            {items.map((c) => (
              <li key={c.id} className="flex items-start justify-between gap-3 py-3">
                <div className="min-w-0 flex-1 space-y-1 text-sm">
                  <p className="[overflow-wrap:anywhere]"><span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Instead of</span> {c.original}</p>
                  <p className="[overflow-wrap:anywhere]"><span className="text-xs font-medium uppercase tracking-wide text-emerald-700 dark:text-emerald-300">Do</span> {c.corrected}</p>
                  {c.note && <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{c.note}</p>}
                  <p className="text-xs text-muted-foreground">{fmtDate(c.created_at)}{c.run_id ? " · from a run" : ""}</p>
                </div>
                <Button variant="ghost" size="icon-sm" touch onClick={() => void remove(c.id)} disabled={deleting === c.id} aria-label="Delete correction">
                  {deleting === c.id ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Trash2 className="h-4 w-4 text-destructive" aria-hidden />}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {adding && (
        <Dialog title="Add a correction" description="Tell the agent what it did and what it should do instead." onClose={() => setAdding(false)}>
          <form onSubmit={submit} className="space-y-4">
            <Field label="What the agent did (original)" required>
              <Textarea value={form.original} onChange={(e) => setForm({ ...form, original: e.target.value })} rows={3} maxLength={4000} autoFocus />
            </Field>
            <Field label="What it should do instead (corrected)" required>
              <Textarea value={form.corrected} onChange={(e) => setForm({ ...form, corrected: e.target.value })} rows={3} maxLength={4000} />
            </Field>
            <Field label="Why (optional)" hint="Context helps the agent generalise the rule.">
              <Input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} maxLength={1000} />
            </Field>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setAdding(false)} disabled={busy}>Cancel</Button>
              <Button type="submit" disabled={busy}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Save className="h-4 w-4" aria-hidden />} Save
              </Button>
            </DialogFooter>
          </form>
        </Dialog>
      )}
    </div>
  );
}

// ── Outcome pricing ──────────────────────────────────────────────────────────

function PricingPanel({ agentId }: { agentId: string }) {
  const [pricing, setPricing] = useState<Pricing | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [event, setEvent] = useState("");
  const [credits, setCredits] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/agents/${agentId}/pricing`, { cache: "no-store" });
      const data = await readJson(res);
      if (!res.ok) throw new Error(data?.error ?? "Could not load outcome pricing.");
      const p = data.pricing as Pricing;
      setPricing(p);
      setEvent(p.outcome_event ?? "");
      setCredits(p.outcome_price_credits == null ? "" : String(p.outcome_price_credits));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load outcome pricing.");
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const n = credits.trim() === "" ? null : Number(credits);
    if (event && (n === null || !Number.isInteger(n) || n < 0)) {
      setError("Enter a whole number of credits (0 or more).");
      return;
    }
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/agents/${agentId}/pricing`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ outcome_event: event || null, outcome_price_credits: event ? n : null }),
      });
      const data = await readJson(res);
      if (!res.ok) throw new Error(data?.error ?? "Could not save outcome pricing.");
      setPricing(data.pricing as Pricing);
      setNotice(event ? `Runs that end with ${event} will be charged ${formatCredits(n ?? 0)}.` : "Outcome pricing turned off.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save outcome pricing.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      {error && <Banner tone="error" onDismiss={() => setError(null)}>{error}</Banner>}
      {notice && <Banner tone="success" onDismiss={() => setNotice(null)}>{notice}</Banner>}
      <section className="rounded-xl border border-border bg-card p-4 sm:p-5" aria-labelledby="pricing-heading">
        <h2 id="pricing-heading" className="flex items-center gap-2 text-sm font-semibold">
          <Coins className="h-4 w-4" aria-hidden /> Outcome pricing
        </h2>
        <p className="mb-4 mt-1 text-xs text-muted-foreground">
          Charge credits only when a run produces a result — a booking, a replied lead, a resolved ticket. The price is debited once per run in which the chosen event fires, on top of regular usage.
        </p>
        {loading && !pricing && <Loading label="Loading pricing…" />}
        {!loading && !pricing && error && <ErrorState message={error} onRetry={() => void load()} />}
        {pricing && (
          <form onSubmit={save} className="grid gap-4 sm:grid-cols-2">
            <Field label="Outcome event" hint="Fired by the events bus when the thing happens.">
              <Select value={event} onChange={(e) => setEvent(e.target.value)}>
                <option value="">Off — usage pricing only</option>
                {pricing.event_types.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </Select>
            </Field>
            <Field label="Price per outcome (credits)" hint="1,000 credits = $1">
              <Input type="number" inputMode="numeric" min={0} step={1} value={credits} onChange={(e) => setCredits(e.target.value)} disabled={!event} placeholder="e.g. 500" />
            </Field>
            <div className="sm:col-span-2">
              <Button type="submit" touch disabled={saving}>
                {saving ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Save className="h-4 w-4" aria-hidden />} Save pricing
              </Button>
            </div>
          </form>
        )}
      </section>
    </div>
  );
}
