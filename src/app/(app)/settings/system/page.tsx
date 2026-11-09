"use client";

import { useCallback, useEffect, useState } from "react";
import { Activity, ChevronDown, ChevronRight, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Banner, Empty, ErrorState, SkeletonList } from "@/components/ui/feedback";
import { Pill, type Tone } from "@/components/ui/pill";
import { TableScroller } from "@/components/ui/table-scroller";
import { isAbortError, useAbortable } from "@/components/ui/hooks";
import { Tabs, TabPanel } from "@/components/ui/tabs";
import { AlertsTab } from "@/components/system/alerts-tab";
import { DiagnosticsTab, type DiagnosticsData } from "@/components/system/diagnostics-tab";
import { PageContainer } from "@/components/page-container";
import { cn } from "@/lib/utils";

type Mode = "live" | "simulated";
interface Configurable { id: string; label?: string; configured: boolean; active?: boolean; model?: string }
interface AppErrorRow {
  id: string; user_id: string | null; route: string; method: string | null; status: number | null; message: string;
  stack: string | null; fingerprint: string; count: number; first_seen: string; last_seen: string;
}
interface Status {
  database: { ok: boolean; latencyMs: number | null; error?: string };
  providers: {
    payments: Configurable[]; email: Mode; sms: Mode; push: Mode; mail: Configurable[]; voice: Mode;
    accounting: Configurable[]; llm: Configurable[];
  };
  cron: { lastTickAt: string; counts: Record<string, number> } | null;
  queue: Record<string, number> | null;
  outbox: Record<string, number> | null;
  webhooks: Record<string, number> | null;
  errors: AppErrorRow[];
  errorsAvailable: boolean;
  vitals: VitalsSummary | null;
  diagnostics?: DiagnosticsData;
}
interface VitalsRow { path: string; name: "LCP" | "CLS" | "INP" | "TTFB" | "FCP"; p75: number; samples: number; good_share: number }
interface VitalsSummary { global: true; windowHours: number; rows: VitalsRow[] }

/** Core Web Vitals "good" thresholds (p75) per web.dev. */
const VITAL_GOOD: Record<VitalsRow["name"], number> = { LCP: 2500, CLS: 0.1, INP: 200, TTFB: 800, FCP: 1800 };
const VITAL_POOR: Record<VitalsRow["name"], number> = { LCP: 4000, CLS: 0.25, INP: 500, TTFB: 1800, FCP: 3000 };
const fmtVital = (name: VitalsRow["name"], v: number) => (name === "CLS" ? v.toFixed(3) : `${Math.round(v)} ms`);
const vitalTone = (name: VitalsRow["name"], v: number): Tone => (v <= VITAL_GOOD[name] ? "success" : v <= VITAL_POOR[name] ? "warning" : "danger");

const spinner = <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />;
const fmtTime = (iso: string | null | undefined) => (iso ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso)) : "Never");

function ago(iso: string | null | undefined): string {
  if (!iso) return "never";
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86_400)}d ago`;
}

function Stat({ label, value, tone = "neutral", hint }: { label: string; value: string | number; tone?: Tone; hint?: string }) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <div className="mt-1 flex flex-wrap items-baseline gap-2">
        <span className="text-2xl font-semibold tabular-nums">{value}</span>
        {tone !== "neutral" && <Pill tone={tone}>{tone === "success" ? "OK" : tone === "warning" ? "Attention" : "Problem"}</Pill>}
      </div>
      {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function ModePill({ mode }: { mode: Mode }) {
  return <Pill tone={mode === "live" ? "success" : "neutral"}>{mode === "live" ? "Live" : "Simulated"}</Pill>;
}

function ProviderRow({ label, items, mode }: { label: string; items?: Configurable[]; mode?: Mode }) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 py-2">
      <span className="text-sm font-medium">{label}</span>
      <span className="flex flex-wrap items-center gap-1.5">
        {mode && <ModePill mode={mode} />}
        {items?.map((p) => (
          <Pill key={p.id} tone={p.configured ? (p.active === false ? "info" : "success") : "neutral"} title={p.model}>
            {p.label ?? p.id}
            {p.active ? " · active" : ""}
            {p.configured ? "" : " · not set"}
          </Pill>
        ))}
        {items && items.length === 0 && <Pill tone="neutral">None</Pill>}
      </span>
    </li>
  );
}

export default function SystemHealthPage() {
  const [status, setStatus] = useState<Status | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [tab, setTab] = useState<"overview" | "alerts" | "diagnostics">("overview");
  const nextSignal = useAbortable();

  const load = useCallback(async () => {
    const signal = nextSignal();
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/system/status", { cache: "no-store", signal });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(res.status === 403 ? "Only workspace owners and admins can view system health." : typeof data?.error === "string" ? data.error : `Could not load system status (${res.status}).`);
        return;
      }
      setStatus(data as Status);
    } catch (e) {
      if (isAbortError(e)) return;
      setError("Could not load system status. Check your connection and try again.");
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }, [nextSignal]);
  useEffect(() => {
    void load();
  }, [load]);

  const cronStale = status?.cron ? Date.now() - new Date(status.cron.lastTickAt).getTime() > 10 * 60_000 : true;
  const queued = (status?.queue?.queued ?? 0) + (status?.queue?.running ?? 0);
  const outboxFailed = status?.outbox?.failed ?? 0;
  const deadHooks = status?.webhooks?.dead ?? 0;

  return (
    <PageContainer
      wide
      title="System health"
      description="Database, providers, background jobs and recent errors for this deployment."
      icon={<Activity className="h-5 w-5" aria-hidden />}
      actions={
        <Button variant="outline" size="icon" touch onClick={() => void load()} disabled={loading} aria-label="Refresh system status">
          {loading ? spinner : <RefreshCw className="h-4 w-4" aria-hidden />}
        </Button>
      }
    >
      <Tabs id="sys" label="System health sections" value={tab} onChange={setTab} className="mb-6"
        tabs={[{ id: "overview", label: "Overview" }, { id: "alerts", label: "Alerts" }, { id: "diagnostics", label: "Diagnostics" }]} />
      {tab === "alerts" && <TabPanel id="sys" value="alerts"><AlertsTab /></TabPanel>}
      {tab === "diagnostics" && status && (
        <TabPanel id="sys" value="diagnostics"><DiagnosticsTab diagnostics={status.diagnostics ?? null} queue={status.queue} errors={status.errors} /></TabPanel>
      )}
      {tab === "overview" && error && status && <Banner tone="error" onDismiss={() => setError(null)}>{error}</Banner>}

      {tab !== "overview" ? null : loading && !status ? (
        <SkeletonList count={4} itemClassName="h-24" label="Loading system status…" />
      ) : !status ? (
        <ErrorState message={error ?? "Could not load system status."} onRetry={() => void load()} />
      ) : (
        <div className="space-y-8" aria-busy={loading || undefined}>
          <section aria-label="Health summary" className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Database" value={status.database.ok ? `${status.database.latencyMs ?? 0} ms` : "Down"} tone={status.database.ok ? "success" : "danger"} hint={status.database.ok ? "SELECT 1 round trip" : status.database.error} />
            <Stat label="Cron last tick" value={status.cron ? ago(status.cron.lastTickAt) : "Never"} tone={status.cron && !cronStale ? "success" : "warning"} hint={status.cron ? fmtTime(status.cron.lastTickAt) : "No tick recorded yet (see cron hook)"} />
            <Stat label="Agent queue" value={queued} tone={queued > 100 ? "warning" : "success"} hint={`${status.queue?.queued ?? 0} queued · ${status.queue?.running ?? 0} running · ${status.queue?.dead ?? 0} dead`} />
            <Stat label="Delivery failures" value={outboxFailed + deadHooks} tone={outboxFailed + deadHooks > 0 ? "warning" : "success"} hint={`${outboxFailed} outbox failed · ${deadHooks} webhook deliveries dead`} />
          </section>

          {status.cron && Object.keys(status.cron.counts).length > 0 && (
            <section aria-labelledby="cron-heading" className="rounded-xl border border-border bg-card p-4 sm:p-5">
              <h2 id="cron-heading" className="text-sm font-semibold">Last cron tick</h2>
              <dl className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
                {Object.entries(status.cron.counts).map(([k, v]) => (
                  <div key={k} className="rounded-lg bg-secondary/40 px-3 py-2">
                    <dt className="text-xs text-muted-foreground first-letter:uppercase">{k.replace(/_/g, " ")}</dt>
                    <dd className="text-sm font-medium tabular-nums">{v}</dd>
                  </div>
                ))}
              </dl>
            </section>
          )}

          <section aria-labelledby="providers-heading" className="rounded-xl border border-border bg-card p-4 sm:p-5">
            <h2 id="providers-heading" className="text-sm font-semibold">Providers</h2>
            <p className="mt-1 text-sm text-muted-foreground">Simulated channels still write to the outbox so nothing is lost; configure keys in the server environment to go live.</p>
            <ul className="mt-3 divide-y divide-border">
              <ProviderRow label="Payments" items={status.providers.payments} />
              <ProviderRow label="Email" mode={status.providers.email} />
              <ProviderRow label="SMS / WhatsApp" mode={status.providers.sms} />
              <ProviderRow label="Push" mode={status.providers.push} />
              <ProviderRow label="Mail inbox" items={status.providers.mail} />
              <ProviderRow label="Voice" mode={status.providers.voice} />
              <ProviderRow label="Accounting" items={status.providers.accounting} />
              <ProviderRow label="Models (LLM)" items={status.providers.llm} />
            </ul>
          </section>

          <VitalsSection vitals={status.vitals} />

          <section aria-labelledby="errors-heading" className="rounded-xl border border-border bg-card p-4 sm:p-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 id="errors-heading" className="text-sm font-semibold">Recent errors</h2>
              <span className="text-xs text-muted-foreground">Grouped by route + message · newest first</span>
            </div>
            {!status.errorsAvailable ? (
              <Banner tone="warn" className="mt-3 mb-0">The app_errors table is not present yet. Apply aws/phase5/a.sql.</Banner>
            ) : status.errors.length === 0 ? (
              <Empty className="mt-3 py-8" title="No errors recorded" text="Server 500s and client crashes will appear here with a count and the last time they happened." />
            ) : (
              <TableScroller label="Recent errors" className="mt-3">
                <table className="w-full min-w-[640px] text-sm">
                  <thead className="text-left text-xs text-muted-foreground">
                    <tr>
                      <th className="w-12 px-2 py-2 sm:w-8"><span className="sr-only">Expand</span></th>
                      <th className="px-2 py-2">Route</th>
                      <th className="px-2 py-2">Message</th>
                      <th className="px-2 py-2 text-right">Count</th>
                      <th className="px-2 py-2">Last seen</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {status.errors.map((e) => {
                      const expanded = open === e.id;
                      return (
                        <ErrorRows key={e.id} row={e} expanded={expanded} onToggle={() => setOpen(expanded ? null : e.id)} />
                      );
                    })}
                  </tbody>
                </table>
              </TableScroller>
            )}
          </section>
        </div>
      )}
    </PageContainer>
  );
}

function ErrorRows({ row, expanded, onToggle }: { row: AppErrorRow; expanded: boolean; onToggle: () => void }) {
  const panelId = `err-${row.id}`;
  return (
    <>
      <tr className={cn("align-top", expanded && "bg-secondary/30")}>
        <td className="px-2 py-2">
          <button type="button" onClick={onToggle} aria-expanded={expanded} aria-controls={panelId} aria-label={expanded ? "Collapse error" : "Expand error"} className="flex h-11 w-11 items-center justify-center rounded-md hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:h-8 sm:w-8">
            {expanded ? <ChevronDown className="h-4 w-4" aria-hidden /> : <ChevronRight className="h-4 w-4" aria-hidden />}
          </button>
        </td>
        <td className="px-2 py-2 font-mono text-xs">
          {row.method && row.method !== "CLIENT" ? <span className="text-muted-foreground">{row.method} </span> : null}
          <span className="break-all">{row.route}</span>
          {row.status ? <Pill tone={row.status >= 500 ? "danger" : "warning"} className="ml-1">{row.status}</Pill> : null}
        </td>
        <td className="max-w-[320px] px-2 py-2"><span className="line-clamp-2 [overflow-wrap:anywhere]">{row.message}</span></td>
        <td className="px-2 py-2 text-right tabular-nums">{row.count}</td>
        <td className="whitespace-nowrap px-2 py-2 text-xs text-muted-foreground">{fmtTime(row.last_seen)}</td>
      </tr>
      {expanded && (
        <tr id={panelId}>
          <td />
          <td colSpan={4} className="px-2 pb-3">
            <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
              <div><dt className="text-muted-foreground">Error id</dt><dd className="break-all font-mono">{row.id}</dd></div>
              <div><dt className="text-muted-foreground">Fingerprint</dt><dd className="break-all font-mono">{row.fingerprint}</dd></div>
              <div><dt className="text-muted-foreground">First seen</dt><dd>{fmtTime(row.first_seen)}</dd></div>
              <div><dt className="text-muted-foreground">User</dt><dd className="break-all font-mono">{row.user_id ?? "anonymous"}</dd></div>
            </dl>
            {row.stack && <pre className="mt-2 max-h-64 overflow-auto rounded-md bg-secondary/50 p-2 font-mono text-[11px] leading-snug [overflow-wrap:anywhere] whitespace-pre-wrap">{row.stack}</pre>}
          </td>
        </tr>
      )}
    </>
  );
}

/** p75 Core Web Vitals by route. Global to the deployment (anonymous samples carry no tenant key). */
function VitalsSection({ vitals }: { vitals: VitalsSummary | null }) {
  const byPath = new Map<string, VitalsRow[]>();
  for (const r of vitals?.rows ?? []) byPath.set(r.path, [...(byPath.get(r.path) ?? []), r]);
  const metrics: VitalsRow["name"][] = ["LCP", "INP", "CLS", "TTFB"];
  return (
    <section aria-labelledby="vitals-heading" className="rounded-xl border border-border bg-card p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="vitals-heading" className="text-sm font-semibold">Web vitals (p75 by route)</h2>
        <span className="flex items-center gap-2 text-xs text-muted-foreground">
          <Pill tone="info">Global · all workspaces</Pill>
          {vitals ? `last ${vitals.windowHours} h · 10% sample` : null}
        </span>
      </div>
      {!vitals ? (
        <Banner tone="warn" className="mt-3 mb-0">The web_vitals table is not present yet. Apply aws/phase6/d.sql and mount &lt;WebVitals /&gt; in the root layout.</Banner>
      ) : byPath.size === 0 ? (
        <Empty className="mt-3 py-8" title="No samples yet" text="Sampled page loads report LCP, INP, CLS and TTFB here. Nothing identifying is stored." />
      ) : (
        <TableScroller label="Web vitals by route" className="mt-3">
          <table className="w-full min-w-[560px] text-sm">
            <thead className="text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-2 py-2">Route</th>
                {metrics.map((m) => <th key={m} className="px-2 py-2 text-right">{m}</th>)}
                <th className="px-2 py-2 text-right">Samples</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {[...byPath.entries()].map(([path, rows]) => {
                const samples = Math.max(...rows.map((r) => r.samples));
                return (
                  <tr key={path}>
                    <td className="px-2 py-2 font-mono text-xs break-all">{path}</td>
                    {metrics.map((m) => {
                      const r = rows.find((x) => x.name === m);
                      return (
                        <td key={m} className="px-2 py-2 text-right tabular-nums">
                          {r ? <Pill tone={vitalTone(m, r.p75)} title={`${Math.round(r.good_share * 100)}% good`}>{fmtVital(m, r.p75)}</Pill> : <span className="text-muted-foreground">—</span>}
                        </td>
                      );
                    })}
                    <td className="px-2 py-2 text-right tabular-nums text-muted-foreground">{samples}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </TableScroller>
      )}
    </section>
  );
}
