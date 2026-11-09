"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowDown, ArrowUp, LayoutDashboard, Minus, Plus, Save, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { Field } from "@/components/ui/field";
import { Banner, Empty, ErrorState, SkeletonList } from "@/components/ui/feedback";
import { Pill } from "@/components/ui/pill";
import { isAbortError, useAbortable } from "@/components/ui/hooks";
import { api } from "@/components/finance/shared";
import { ReportChart } from "./report-chart";
import { ReportTable } from "./report-table";
import { AgencyRollup, JobCostingWidget, useRangeQs, useReportRange } from "./job-costing-widget";
import type { DashboardDTO, LayoutItemDTO, RunResult, SavedReportDTO } from "./types";
import type { HomeSummary, KpiTile } from "@/lib/home/kpis";
import { cn } from "@/lib/utils";

/**
 * Dashboards tab: a 12-column grid of saved-report cards and built-in widgets.
 * The default dashboard per role is editable by admins; everyone sees their
 * role's default (or the starter layout when none is saved).
 */

const ROLES = ["owner", "admin", "manager", "member", "viewer"] as const;
const BUILTINS: Array<{ key: NonNullable<LayoutItemDTO["builtin"]>; label: string }> = [
  { key: "kpis", label: "KPI tiles" },
  { key: "needs_you", label: "Needs you" },
  { key: "job_costing", label: "Job costing" },
  { key: "agency_rollup", label: "Client workspaces (agency)" },
  { key: "cashflow", label: "Cash-flow forecast" },
];
const WIDTHS = [3, 4, 6, 8, 12];

interface Props {
  reports: SavedReportDTO[];
  role: string;
  canAdmin: boolean;
}

export function Dashboards({ reports, role, canAdmin }: Props) {
  const [viewRole, setViewRole] = useState(role);
  const [dash, setDash] = useState<DashboardDTO | null>(null);
  const [saved, setSaved] = useState(false);
  const [editing, setEditing] = useState(false);
  const [layout, setLayout] = useState<LayoutItemDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [addKind, setAddKind] = useState<string>("builtin:kpis");
  const nextSignal = useAbortable();

  const load = useCallback(async () => {
    const signal = nextSignal();
    setLoading(true);
    setError(null);
    try {
      const r = await api<{ dashboard: DashboardDTO; saved: boolean }>(`/api/dashboards?role=${encodeURIComponent(viewRole)}`, { signal });
      setDash(r.dashboard);
      setSaved(r.saved);
      setLayout(r.dashboard.layout);
    } catch (e) {
      if (isAbortError(e)) return;
      setError(e instanceof Error ? e.message : "Could not load the dashboard.");
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }, [viewRole, nextSignal]);
  useEffect(() => { void load(); }, [load]);

  async function save() {
    if (!dash) return;
    setSaving(true);
    setError(null);
    try {
      const body = JSON.stringify({ name: dash.name, role: viewRole, layout, is_default: true });
      if (saved && dash.id) await api(`/api/dashboards/${dash.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body });
      else await api("/api/dashboards", { method: "POST", headers: { "content-type": "application/json" }, body });
      setEditing(false);
      setNotice(`Saved as the default dashboard for ${viewRole}s.`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the dashboard.");
    } finally {
      setSaving(false);
    }
  }

  function add() {
    const [kind, id] = addKind.split(":");
    const item: LayoutItemDTO = kind === "builtin" ? { builtin: id as LayoutItemDTO["builtin"], x: 0, y: layout.length, w: 6, h: 2 } : { report_id: id, x: 0, y: layout.length, w: 6, h: 2 };
    setLayout((l) => [...l, item]);
  }
  const patch = (i: number, p: Partial<LayoutItemDTO>) => setLayout((l) => l.map((it, j) => (j === i ? { ...it, ...p } : it)));
  const move = (i: number, dir: -1 | 1) => setLayout((l) => { const n = [...l]; const j = i + dir; if (j < 0 || j >= n.length) return l; [n[i], n[j]] = [n[j], n[i]]; return n; });

  const { preset, range, pick, setRange } = useReportRange();
  const qs = useRangeQs(range)();
  void setRange;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap items-end gap-3">
          {canAdmin && (
            <Field label="Default for role">
              <Select value={viewRole} onChange={(e) => { setViewRole(e.target.value); setEditing(false); }}>
                {ROLES.map((r) => (
                  <option key={r} value={r} className="capitalize">{r}</option>
                ))}
              </Select>
            </Field>
          )}
          <div className="flex items-center gap-2 pb-1 text-sm text-muted-foreground">
            <LayoutDashboard className="h-4 w-4" aria-hidden />
            <span>{dash?.name ?? "Dashboard"}</span>
            {saved ? <Pill tone="success">Saved default</Pill> : <Pill tone="neutral">Starter layout</Pill>}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <div role="group" aria-label="Date range for built-in widgets" className="flex items-center gap-1 rounded-lg border border-border bg-card p-1">
            {(["30d", "90d", "ytd"] as const).map((p) => (
              <button key={p} type="button" aria-pressed={preset === p} onClick={() => pick(p)} className={cn("inline-flex min-h-11 items-center rounded-md px-2.5 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-8", preset === p ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-secondary/60")}>
                {p === "30d" ? "30 days" : p === "90d" ? "90 days" : "This year"}
              </button>
            ))}
          </div>
          {canAdmin && !editing && <Button variant="outline" touch onClick={() => setEditing(true)}>Edit layout</Button>}
          {canAdmin && editing && (
            <>
              <Button variant="outline" touch onClick={() => { setEditing(false); setLayout(dash?.layout ?? []); }}>Cancel</Button>
              <Button touch onClick={() => void save()} disabled={saving}><Save className="h-4 w-4" aria-hidden /> {saving ? "Saving…" : "Save default"}</Button>
            </>
          )}
        </div>
      </div>

      {error && <Banner tone="error" onDismiss={() => setError(null)}>{error}</Banner>}
      {notice && <Banner tone="success" onDismiss={() => setNotice(null)}>{notice}</Banner>}

      {editing && (
        <div className="flex flex-wrap items-end gap-2 rounded-xl border border-dashed border-border p-3">
          <Field label="Add widget" className="min-w-[14rem] flex-1">
            <Select value={addKind} onChange={(e) => setAddKind(e.target.value)}>
              <optgroup label="Built-in">
                {BUILTINS.map((b) => (
                  <option key={b.key} value={`builtin:${b.key}`}>{b.label}</option>
                ))}
              </optgroup>
              {reports.length > 0 && (
                <optgroup label="Saved reports">
                  {reports.map((r) => (
                    <option key={r.id} value={`report:${r.id}`}>{r.name}</option>
                  ))}
                </optgroup>
              )}
            </Select>
          </Field>
          <Button type="button" variant="outline" touch onClick={add} disabled={layout.length >= 40}><Plus className="h-4 w-4" aria-hidden /> Add</Button>
        </div>
      )}

      {loading && !dash ? (
        <SkeletonList count={3} itemClassName="h-40" />
      ) : layout.length === 0 ? (
        <Empty
          icon={<LayoutDashboard className="h-5 w-5" aria-hidden />}
          title="Empty dashboard"
          text={canAdmin ? "Add KPI tiles, built-in widgets or saved reports." : "An admin has not set up a dashboard for your role yet."}
          action={canAdmin && !editing ? <Button variant="outline" touch onClick={() => setEditing(true)}>Edit layout</Button> : undefined}
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-12" aria-busy={loading || undefined} aria-live="polite" aria-relevant="additions removals">
          {layout.map((item, i) => {
            const report = item.report_id ? reports.find((r) => r.id === item.report_id) : null;
            const title = item.builtin ? (BUILTINS.find((b) => b.key === item.builtin)?.label ?? item.builtin) : (report?.name ?? "Report");
            return (
              <section key={`${item.builtin ?? item.report_id}-${i}`} aria-label={title} className={cn("min-w-0 rounded-xl border border-border bg-card p-4", spanClass(item.w))} style={{ minHeight: `${item.h * 7}rem` }}>
                <div className="mb-3 flex items-start justify-between gap-2">
                  <h3 className="truncate text-sm font-semibold">{title}</h3>
                  {editing && (
                    <div className="flex shrink-0 flex-wrap items-center gap-1" role="group" aria-label={`Arrange ${title}`}>
                      <Select aria-label={`Width of ${title}`} value={item.w} onChange={(e) => patch(i, { w: Number(e.target.value) })} className="h-11 w-20 py-0 text-xs sm:h-8">
                        {WIDTHS.map((w) => (
                          <option key={w} value={w}>{w}/12</option>
                        ))}
                      </Select>
                      <Button size="icon" variant="ghost" touch onClick={() => patch(i, { h: Math.max(1, item.h - 1) })} aria-label={`Make ${title} shorter`} disabled={item.h <= 1}><Minus className="h-4 w-4" aria-hidden /></Button>
                      <Button size="icon" variant="ghost" touch onClick={() => patch(i, { h: Math.min(6, item.h + 1) })} aria-label={`Make ${title} taller`} disabled={item.h >= 6}><Plus className="h-4 w-4" aria-hidden /></Button>
                      <Button size="icon" variant="ghost" touch onClick={() => move(i, -1)} aria-label={`Move ${title} earlier`} disabled={i === 0}><ArrowUp className="h-4 w-4" aria-hidden /></Button>
                      <Button size="icon" variant="ghost" touch onClick={() => move(i, 1)} aria-label={`Move ${title} later`} disabled={i === layout.length - 1}><ArrowDown className="h-4 w-4" aria-hidden /></Button>
                      <Button size="icon" variant="ghost" touch onClick={() => setLayout((l) => l.filter((_, j) => j !== i))} aria-label={`Remove ${title}`}><Trash2 className="h-4 w-4" aria-hidden /></Button>
                    </div>
                  )}
                </div>
                {item.builtin === "job_costing" && <JobCostingWidget qs={qs} compact />}
                {item.builtin === "agency_rollup" && <AgencyRollup qs={qs} />}
                {(item.builtin === "kpis" || item.builtin === "needs_you" || item.builtin === "cashflow") && <HomeWidget kind={item.builtin} />}
                {item.report_id && (report ? <ReportCard report={report} compact /> : <p className="text-sm text-muted-foreground">This report no longer exists or is private to its author.</p>)}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}

function spanClass(w: number): string {
  if (w <= 3) return "md:col-span-3";
  if (w <= 4) return "md:col-span-4";
  if (w <= 6) return "md:col-span-6";
  if (w <= 8) return "md:col-span-8";
  return "md:col-span-12";
}

/** Saved report card: runs on mount, shows the chart (or table). */
export function ReportCard({ report, compact }: { report: SavedReportDTO; compact?: boolean }) {
  const [res, setRes] = useState<RunResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const nextSignal = useAbortable();
  const load = useCallback(async () => {
    const signal = nextSignal();
    setError(null);
    try {
      const r = await api<{ result: RunResult }>(`/api/reports/saved/${report.id}/run`, { method: "POST", signal });
      setRes(r.result);
    } catch (e) {
      if (isAbortError(e)) return;
      setError(e instanceof Error ? e.message : "Could not run.");
    }
  }, [report.id, nextSignal]);
  useEffect(() => { void load(); }, [load]);
  if (error) return <ErrorState message={error} onRetry={() => void load()} />;
  if (!res) return <SkeletonList count={1} itemClassName="h-32" />;
  if (report.chart.type === "table") return <ReportTable rows={res.rows} columns={res.columns} totals={res.totals} currency={res.currency} label={report.name} max={compact ? 8 : 50} />;
  return (
    <div className="space-y-2">
      <ReportChart rows={res.rows} columns={res.columns} chart={report.chart} currency={res.currency} title={report.name} compact={compact} />
      {res.rows.length > 0 && (
        <details className="text-xs">
          <summary className="inline-flex min-h-11 cursor-pointer items-center rounded text-muted-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-0">View as table</summary>
          <ReportTable rows={res.rows} columns={res.columns} totals={res.totals} currency={res.currency} label={`${report.name} data`} max={compact ? 8 : 50} className="mt-2" />
        </details>
      )}
    </div>
  );
}

let summaryCache: { at: number; p: Promise<HomeSummary> } | null = null;
function loadSummary(): Promise<HomeSummary> {
  if (summaryCache && Date.now() - summaryCache.at < 30_000) return summaryCache.p;
  const p = api<HomeSummary>("/api/home/summary");
  summaryCache = { at: Date.now(), p };
  return p;
}

function HomeWidget({ kind }: { kind: "kpis" | "needs_you" | "cashflow" }) {
  const [s, setS] = useState<HomeSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    loadSummary().then((v) => live && setS(v)).catch((e) => live && setError(e instanceof Error ? e.message : "Could not load."));
    return () => { live = false; };
  }, []);
  if (error) return <ErrorState message={error} />;
  if (!s) return <SkeletonList count={1} itemClassName="h-24" />;
  if (kind === "kpis") {
    const tiles: KpiTile[] = s.kpis ?? [];
    if (tiles.length === 0) return <p className="text-sm text-muted-foreground">No KPIs for your role.</p>;
    return (
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {tiles.map((t) => (
          <Link key={t.key} href={t.href ?? "/home"} className="rounded-lg border border-border p-3 hover:bg-secondary/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">{t.label}</p>
            <p className="mt-1 text-lg font-semibold tabular-nums">{t.value}</p>
            {t.hint && <p className="truncate text-xs text-muted-foreground">{t.hint}</p>}
          </Link>
        ))}
      </div>
    );
  }
  if (kind === "needs_you") {
    const items = s.needsYou ?? [];
    if (items.length === 0) return <p className="text-sm text-muted-foreground">Nothing is waiting on you.</p>;
    return (
      <ul className="divide-y divide-border text-sm">
        {items.slice(0, 8).map((n) => (
          <li key={`${n.kind}-${n.id}`}>
            <Link href={n.href} className="flex min-h-11 flex-col justify-center rounded-md px-1 py-1.5 hover:bg-secondary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <span className="truncate font-medium">{n.title}</span>
              <span className="truncate text-xs text-muted-foreground">{n.detail}</span>
            </Link>
          </li>
        ))}
      </ul>
    );
  }
  const cf = s.cashflow;
  if (!cf || cf.points.length === 0) return <p className="text-sm text-muted-foreground">No forecast yet.</p>;
  return (
    <ReportChart
      rows={cf.points.map((p) => ({ week: p.weekStart, balance: p.balance }))}
      columns={[{ key: "week", label: "Week", kind: "date", format: null, field: "week", agg: null, bucket: "week" }, { key: "balance", label: "Projected balance", kind: "measure", format: "money", field: "balance", agg: null, bucket: null }]}
      chart={{ type: "line", x: "week", y: ["balance"] }}
      currency={cf.currency}
      title="Cash-flow forecast"
      compact
    />
  );
}
