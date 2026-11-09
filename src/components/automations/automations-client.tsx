"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { UpgradePrompt } from "@/components/plans/upgrade-prompt";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertCircle, Clock, Download, Pencil, Plus, Trash2, Zap } from "lucide-react";
import { PageContainer } from "@/components/page-container";
import { Button } from "@/components/ui/button";
import { Dialog, DialogFooter } from "@/components/ui/dialog";
import { Banner, Empty, ErrorState, SkeletonList } from "@/components/ui/feedback";
import { Pill, StatusPill } from "@/components/ui/pill";
import { SearchField } from "@/components/ui/search-field";
import { Tabs, TabPanel } from "@/components/ui/tabs";
import { TableScroller, TH, THEAD } from "@/components/ui/table-scroller";
import { timeAgo } from "@/lib/utils";
import type { AutomationDTO, AutomationRunDTO } from "@/lib/automations/types";
import type { AutomationTemplate } from "@/lib/automations/templates";
import { RunDrawer } from "./run-drawer";
import { apiJson, describeTrigger, fmtDate, RUN_TONE, runDuration, type AutomationWithStats } from "./shared";

type Tab = "automations" | "runs" | "templates";

/** /automations — list with enable toggles + stats, cross-automation run history, templates gallery. */
export function AutomationsClient() {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("automations");
  const [items, setItems] = useState<AutomationWithStats[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<AutomationDTO | null>(null);
  const [runs, setRuns] = useState<AutomationRunDTO[] | null>(null);
  const [runsErr, setRunsErr] = useState<string | null>(null);
  const [openRun, setOpenRun] = useState<AutomationRunDTO | null>(null);
  const [templates, setTemplates] = useState<AutomationTemplate[] | null>(null);
  const [tplErr, setTplErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setErr(null);
    try {
      const r = await apiJson<{ automations: AutomationWithStats[] }>("/api/automations");
      setItems(r.automations);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to load");
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const loadRuns = useCallback(async () => {
    setRunsErr(null);
    try {
      const r = await apiJson<{ runs: AutomationRunDTO[] }>("/api/automations/runs?limit=100");
      setRuns(r.runs);
    } catch (e) {
      setRunsErr(e instanceof Error ? e.message : "Failed to load runs");
    }
  }, []);
  const loadTemplates = useCallback(async () => {
    setTplErr(null);
    try {
      const r = await apiJson<{ templates: AutomationTemplate[] }>("/api/automations/templates");
      setTemplates(r.templates);
    } catch (e) {
      setTplErr(e instanceof Error ? e.message : "Failed to load templates");
    }
  }, []);
  useEffect(() => {
    if (tab === "runs" && runs === null) void loadRuns();
    if (tab === "templates" && templates === null) void loadTemplates();
  }, [tab, runs, templates, loadRuns, loadTemplates]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (items ?? []).filter((a) => !needle || a.name.toLowerCase().includes(needle) || describeTrigger(a).toLowerCase().includes(needle));
  }, [items, q]);

  const toggle = async (a: AutomationWithStats) => {
    setBusyId(a.id);
    try {
      const r = await apiJson<{ automation: AutomationDTO }>(`/api/automations/${a.id}`, { method: "PATCH", json: { enabled: !a.enabled } });
      setItems((xs) => xs?.map((x) => (x.id === a.id ? { ...x, ...r.automation } : x)) ?? xs);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Update failed");
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (a: AutomationDTO) => {
    setBusyId(a.id);
    try {
      await apiJson(`/api/automations/${a.id}`, { method: "DELETE" });
      setItems((xs) => xs?.filter((x) => x.id !== a.id) ?? xs);
      setConfirmDelete(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Delete failed");
    } finally {
      setBusyId(null);
    }
  };

  const install = async (t: AutomationTemplate) => {
    setBusyId(t.key);
    setTplErr(null);
    try {
      const r = await apiJson<{ automation: AutomationDTO; swapped_tool: string | null }>("/api/automations/templates", { method: "POST", json: { key: t.key } });
      setNotice(`Installed “${r.automation.name}” (paused). Review it and switch it on.${r.swapped_tool ? ` ${r.swapped_tool} is not available, so that step creates a task instead.` : ""}`);
      router.push(`/automations/${r.automation.id}`);
    } catch (e) {
      setTplErr(e instanceof Error ? e.message : "Install failed");
    } finally {
      setBusyId(null);
    }
  };

  const counts = { enabled: items?.filter((a) => a.enabled).length ?? 0, waiting: items?.reduce((n, a) => n + a.stats.waiting, 0) ?? 0, failed: items?.reduce((n, a) => n + a.stats.failed, 0) ?? 0 };

  return (
    <PageContainer
      wide
      title="Automations"
      description="Event-driven workflows: when something happens, check conditions, then run tools, notify people or ask an agent."
      icon={<Zap className="h-5 w-5" aria-hidden />}
      actions={
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" touch onClick={() => setTab("templates")}>
            <Download className="h-4 w-4" aria-hidden /> Templates
          </Button>
          <Button asChild touch>
            <Link href="/automations/new">
              <Plus className="h-4 w-4" aria-hidden /> New automation
            </Link>
          </Button>
        </div>
      }
    >
      {notice && <Banner tone="success" onDismiss={() => setNotice(null)}>{notice}</Banner>}
      {err && <Banner tone="error" onDismiss={() => setErr(null)}>{err}</Banner>}
      <UpgradePrompt feature="automations_v2" className="mb-4" />

      <div className="mb-4 grid grid-cols-3 gap-2 sm:max-w-md">
        <Stat label="Enabled" value={counts.enabled} />
        <Stat label="Waiting" value={counts.waiting} tone={counts.waiting ? "warning" : "neutral"} />
        <Stat label="Failed runs" value={counts.failed} tone={counts.failed ? "danger" : "neutral"} />
      </div>

      <Tabs id="automations-tabs" label="Automations sections" tabs={[{ id: "automations", label: "Automations", count: items?.length }, { id: "runs", label: "Run history" }, { id: "templates", label: "Templates" }]} value={tab} onChange={setTab} className="mb-4" />

      <TabPanel id="automations" value={tab}>
        <SearchField label="Search automations" placeholder="Search by name or trigger" value={q} onChange={setQ} className="mb-3 sm:max-w-sm" />
        {err && !items ? (
          <ErrorState message={err} onRetry={() => void load()} />
        ) : items === null ? (
          <SkeletonList count={4} />
        ) : filtered.length === 0 ? (
          <Empty
            icon={<Zap className="h-6 w-6" aria-hidden />}
            title={items.length === 0 ? "No automations yet" : "Nothing matches"}
            text={items.length === 0 ? "Start from a template or build one from scratch." : "Try a different search."}
            action={items.length === 0 ? <Button type="button" variant="outline" touch onClick={() => setTab("templates")}>Browse templates</Button> : <Button type="button" variant="outline" touch onClick={() => setQ("")}>Clear search</Button>}
          />
        ) : (
          <ul className="space-y-2">
            {filtered.map((a) => (
              <li key={a.id} className="rounded-xl border border-border bg-card p-3 sm:p-4">
                <div className="flex flex-wrap items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link href={`/automations/${a.id}`} className="font-medium hover:underline">
                        {a.name}
                      </Link>
                      <StatusPill status={a.enabled ? "active" : "paused"} map={{ active: "success", paused: "neutral" }} label={a.enabled ? "On" : "Off"} />
                      {a.legacy && <Pill tone="violet">legacy</Pill>}
                      {a.template_key && <Pill>template</Pill>}
                      {a.stats.waiting > 0 && <Pill tone="warning">{a.stats.waiting} waiting</Pill>}
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      <span className="capitalize">{a.trigger_type}</span> · {describeTrigger(a)} · {a.steps.length} step{a.steps.length === 1 ? "" : "s"} · {a.autonomy === "auto" ? "automatic" : "approve writes"}
                    </p>
                    <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                      <span className="inline-flex items-center gap-1">
                        <Clock className="h-3 w-3" aria-hidden /> {a.last_run_at ? `ran ${timeAgo(a.last_run_at)}` : "never ran"}
                      </span>
                      <span>{a.run_count} runs</span>
                      {a.error_count > 0 && <span className="text-destructive">{a.error_count} errors</span>}
                    </p>
                    {a.last_error && (
                      <p className="mt-1 inline-flex items-start gap-1 text-xs text-destructive">
                        <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden /> <span className="break-words">{a.last_error}</span>
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-1">
                    <Button type="button" size="sm" touch variant={a.enabled ? "secondary" : "default"} disabled={busyId === a.id} onClick={() => toggle(a)} aria-pressed={a.enabled} aria-label={`${a.enabled ? "Disable" : "Enable"} ${a.name}`}>
                      {a.enabled ? "Disable" : "Enable"}
                    </Button>
                    <Button asChild variant="ghost" size="icon-sm" touch>
                      <Link href={`/automations/${a.id}`} aria-label={`Edit ${a.name}`}>
                        <Pencil className="h-4 w-4" aria-hidden />
                      </Link>
                    </Button>
                    <Button type="button" variant="ghost" size="icon-sm" touch aria-label={`Delete ${a.name}`} onClick={() => setConfirmDelete(a)}>
                      <Trash2 className="h-4 w-4" aria-hidden />
                    </Button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </TabPanel>

      <TabPanel id="runs" value={tab}>
        {runsErr ? (
          <ErrorState message={runsErr} onRetry={() => void loadRuns()} />
        ) : runs === null ? (
          <SkeletonList count={5} itemClassName="h-10" />
        ) : runs.length === 0 ? (
          <Empty title="No runs yet" text="Runs appear here when an automation fires." />
        ) : (
          <TableScroller label="Recent runs">
            <table className="w-full min-w-[44rem] text-sm">
              <thead className={THEAD}>
                <tr>
                  <th scope="col" className={TH}>When</th>
                  <th scope="col" className={TH}>Automation</th>
                  <th scope="col" className={TH}>Status</th>
                  <th scope="col" className={TH}>Event</th>
                  <th scope="col" className={TH}>Duration</th>
                  <th scope="col" className={TH}>Error</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id} className="border-t border-border hover:bg-secondary/40">
                    <td className="px-3 py-2">
                      <button type="button" className="rounded text-start underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => setOpenRun(r)} aria-label={`Open run from ${fmtDate(r.created_at)}`}>
                        {fmtDate(r.created_at)}
                      </button>
                    </td>
                    <td className="px-3 py-2">{r.automation_name ?? r.automation_id.slice(0, 8)}</td>
                    <td className="px-3 py-2"><StatusPill status={r.status} map={RUN_TONE} /></td>
                    <td className="px-3 py-2 text-xs">{r.context?.event.type ?? "—"}</td>
                    <td className="px-3 py-2 tabular-nums">{runDuration(r)}</td>
                    <td className="max-w-[16rem] truncate px-3 py-2 text-xs text-destructive">{r.error ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroller>
        )}
      </TabPanel>

      <TabPanel id="templates" value={tab}>
        {tplErr && <Banner tone="error" onDismiss={() => setTplErr(null)}>{tplErr}</Banner>}
        {templates === null && !tplErr ? (
          <SkeletonList count={4} />
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {(templates ?? []).map((t) => (
              <li key={t.key} className="flex flex-col rounded-xl border border-border bg-card p-4">
                <div className="mb-1 flex items-center gap-2">
                  <Pill tone="accent">{t.category}</Pill>
                  <span className="text-xs text-muted-foreground">{t.definition.steps.length} steps</span>
                </div>
                <h3 className="font-medium">{t.title}</h3>
                <p className="mt-1 flex-1 text-sm text-muted-foreground">{t.summary}</p>
                <p className="mt-2 text-xs text-muted-foreground">Trigger: {describeTrigger(t.definition)}</p>
                <Button type="button" className="mt-3 self-start" size="sm" touch disabled={busyId === t.key} onClick={() => install(t)}>
                  <Download className="h-3.5 w-3.5" aria-hidden /> {busyId === t.key ? "Installing…" : "Install"}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </TabPanel>

      {openRun && <RunDrawer run={openRun} onClose={() => setOpenRun(null)} onRetried={(r) => { setOpenRun(r); setRuns((rs) => rs?.map((x) => (x.id === r.id ? r : x)) ?? rs); }} />}

      {confirmDelete && (
        <Dialog title={`Delete “${confirmDelete.name}”?`} description="The automation and its run history are removed. This cannot be undone." onClose={() => setConfirmDelete(null)} size="sm">
          <DialogFooter>
            <Button type="button" variant="outline" touch onClick={() => setConfirmDelete(null)}>
              Cancel
            </Button>
            <Button type="button" variant="destructive" touch disabled={busyId === confirmDelete.id} onClick={() => remove(confirmDelete)}>
              {busyId === confirmDelete.id ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </Dialog>
      )}
    </PageContainer>
  );
}

function Stat({ label, value, tone = "neutral" }: { label: string; value: number; tone?: "neutral" | "warning" | "danger" }) {
  const color = tone === "danger" ? "text-destructive" : tone === "warning" ? "text-amber-600 dark:text-amber-400" : "";
  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={`text-lg font-semibold tabular-nums ${color}`}>{value}</p>
    </div>
  );
}
