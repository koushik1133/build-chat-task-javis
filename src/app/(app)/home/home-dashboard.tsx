"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle, ArrowDownRight, ArrowUpRight, Bot, CalendarDays, CheckCircle2, ChevronRight, Command, Database,
  FilePlus2, LayoutDashboard, LifeBuoy, Loader2, RefreshCw, Sparkles, Timer, UserPlus, X,
} from "lucide-react";
import { PageContainer } from "@/components/page-container";
import { Button } from "@/components/ui/button";
import { Banner, Empty, ErrorState, Skeleton } from "@/components/ui/feedback";
import { Pill, StatusPill } from "@/components/ui/pill";
import { isAbortError, useAbortable } from "@/components/ui/hooks";
import { cn } from "@/lib/utils";
import { sparklineScale, type HomeSummary, type KpiTile } from "@/lib/home/kpis";
import type { Checklist } from "@/lib/onboarding/checklist";

interface OnboardingStatusDTO {
  completedAt: string | null;
  checklistDismissed: boolean;
  checklist: Checklist;
  canEdit: boolean;
}

async function readError(res: Response, fallback: string): Promise<string> {
  const d = await res.json().catch(() => null);
  return typeof d?.error === "string" ? d.error : `${fallback} (${res.status})`;
}

const TONE_TEXT: Record<NonNullable<KpiTile["tone"]>, string> = {
  neutral: "text-muted-foreground",
  good: "text-emerald-700 dark:text-emerald-300",
  bad: "text-red-700 dark:text-red-300",
  warn: "text-amber-700 dark:text-amber-300",
};

function fmtTime(iso: string, tz: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", timeZone: tz }).format(new Date(iso));
  } catch {
    return new Date(iso).toLocaleTimeString();
  }
}

function greeting(now: Date): string {
  const h = now.getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

export function HomeDashboard({ firstName }: { firstName: string | null }) {
  const [summary, setSummary] = useState<HomeSummary | null>(null);
  const [status, setStatus] = useState<OnboardingStatusDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState<"seed" | "clear" | null>(null);
  const signal = useAbortable();

  const load = useCallback(async () => {
    setError(null);
    try {
      const s = signal();
      const [a, b] = await Promise.all([
        fetch("/api/home/summary", { signal: s, cache: "no-store" }),
        fetch("/api/onboarding/status", { signal: s, cache: "no-store" }),
      ]);
      if (!a.ok) throw new Error(await readError(a, "Could not load your dashboard"));
      setSummary((await a.json()) as HomeSummary);
      setStatus(b.ok ? ((await b.json()) as OnboardingStatusDTO) : null);
    } catch (err) {
      if (!isAbortError(err)) setError(err instanceof Error ? err.message : "Could not load your dashboard");
    }
  }, [signal]);

  useEffect(() => {
    void load();
  }, [load]);

  const seed = async () => {
    setBusy("seed");
    setNotice(null);
    try {
      const res = await fetch("/api/demo/seed", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      if (!res.ok) throw new Error(await readError(res, "Could not load sample data"));
      const d = (await res.json()) as { seeded: boolean; warnings?: string[] };
      setNotice({ tone: "success", text: d.seeded ? "Sample data loaded. Explore the dashboard, then clear it when you're ready." : "Sample data was already loaded." });
      await load();
    } catch (err) {
      setNotice({ tone: "error", text: err instanceof Error ? err.message : "Could not load sample data" });
    } finally {
      setBusy(null);
    }
  };

  const clear = async () => {
    if (!window.confirm("Remove all sample data? Your own records are kept.")) return;
    setBusy("clear");
    setNotice(null);
    try {
      const res = await fetch("/api/demo/clear", { method: "DELETE" });
      if (!res.ok) throw new Error(await readError(res, "Could not clear sample data"));
      setNotice({ tone: "success", text: "Sample data removed." });
      await load();
    } catch (err) {
      setNotice({ tone: "error", text: err instanceof Error ? err.message : "Could not clear sample data" });
    } finally {
      setBusy(null);
    }
  };

  const dismissChecklist = async () => {
    setStatus((s) => (s ? { ...s, checklistDismissed: true } : s));
    await fetch("/api/onboarding/status", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ dismissed: true }) }).catch(() => undefined);
  };

  const now = useMemo(() => new Date(), []);
  const title = firstName ? `${greeting(now)}, ${firstName}` : greeting(now);
  const showChecklist = status && !status.checklistDismissed && !status.checklist.complete;

  return (
    <PageContainer
      wide
      title={title}
      description={now.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}
      icon={<LayoutDashboard className="h-5 w-5" />}
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => void load()} aria-label="Refresh dashboard">
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" aria-hidden /> Refresh
          </Button>
          <QuickActions />
        </div>
      }
    >
      {notice && <Banner tone={notice.tone} onDismiss={() => setNotice(null)}>{notice.text}</Banner>}

      {summary?.demo.active && (
        <Banner tone="info">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="inline-flex items-center gap-2">
              <Database className="h-4 w-4" aria-hidden /> Sample data loaded ({summary.demo.rows} rows). Everything tagged as demo can be removed in one click.
            </span>
            <Button size="sm" variant="outline" onClick={() => void clear()} disabled={busy !== null}>
              {busy === "clear" ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden /> : <X className="mr-1.5 h-3.5 w-3.5" aria-hidden />} Clear
            </Button>
          </div>
        </Banner>
      )}

      {error && !summary && <ErrorState message={error} onRetry={() => void load()} />}
      {!error && !summary && <DashboardSkeleton />}

      {summary && (
        <div className="space-y-6">
          {showChecklist && status && <SetupChecklist status={status} onDismiss={dismissChecklist} />}

          {summary.empty && !summary.demo.active && (
            <Empty
              icon={<Sparkles className="h-5 w-5" />}
              title="Your workspace is ready"
              text="Add your first contact or quote, or explore KernelHub with realistic sample data you can remove at any time."
              action={
                <div className="flex flex-wrap justify-center gap-2">
                  <Button onClick={() => void seed()} disabled={busy !== null}>
                    {busy === "seed" ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden /> : <Database className="mr-1.5 h-4 w-4" aria-hidden />} Explore with sample data
                  </Button>
                  <Button variant="outline" asChild><Link href="/onboarding">Set up my business</Link></Button>
                </div>
              }
            />
          )}

          {summary.kpis && summary.kpis.length > 0 && (
            <section aria-labelledby="kpi-heading">
              <h2 id="kpi-heading" className="sr-only">Key numbers</h2>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-7">
                {summary.kpis.map((k) => <KpiCard key={k.key} tile={k} />)}
              </div>
            </section>
          )}

          <div className="grid gap-6 lg:grid-cols-3">
            <div className="space-y-6 lg:col-span-2">
              {summary.needsYou && (
                <Card title="Needs you" icon={<AlertTriangle className="h-4 w-4" />} count={summary.needsYou.length}>
                  {summary.needsYou.length === 0 ? (
                    <p className="flex items-center gap-2 py-4 text-sm text-muted-foreground"><CheckCircle2 className="h-4 w-4 text-emerald-600" aria-hidden /> Nothing is waiting on you right now.</p>
                  ) : (
                    <ul className="divide-y divide-border">
                      {summary.needsYou.map((n) => (
                        <li key={`${n.kind}:${n.id}`}>
                          <Link href={n.href} className="flex items-start gap-3 py-2.5 hover:bg-secondary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-md -mx-1 px-1">
                            <Pill tone={n.kind === "approval" ? "violet" : n.kind === "sla" ? "danger" : n.kind === "invoice" ? "warning" : "info"} className="mt-0.5 shrink-0">{n.kind}</Pill>
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-sm font-medium">{n.title}</span>
                              <span className="block truncate text-xs text-muted-foreground">{n.detail}</span>
                            </span>
                            <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                          </Link>
                        </li>
                      ))}
                    </ul>
                  )}
                </Card>
              )}

              {summary.today && (
                <Card title="Today" icon={<CalendarDays className="h-4 w-4" />} count={summary.today.length}>
                  {summary.today.length === 0 ? (
                    <p className="py-4 text-sm text-muted-foreground">No bookings or due items today.</p>
                  ) : (
                    <ol className="space-y-1">
                      {summary.today.map((t) => (
                        <li key={`${t.kind}:${t.id}`}>
                          <Link href={t.href} className="flex items-center gap-3 rounded-md px-1 py-2 hover:bg-secondary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                            <span className="w-16 shrink-0 text-xs tabular-nums text-muted-foreground">{t.at ? fmtTime(t.at, summary.timezone) : "—"}</span>
                            <span className={cn("h-2 w-2 shrink-0 rounded-full", t.kind === "booking" ? "bg-primary" : "bg-amber-500")} aria-hidden />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-sm">{t.title}</span>
                              {t.detail && <span className="block truncate text-xs text-muted-foreground">{t.detail}</span>}
                            </span>
                          </Link>
                        </li>
                      ))}
                    </ol>
                  )}
                </Card>
              )}
            </div>

            <div className="space-y-6">
              {summary.cashflow && summary.cashflow.points.length > 0 && <CashflowCard data={summary.cashflow} />}

              {summary.agents && (
                <Card title="Agents working" icon={<Bot className="h-4 w-4" />}>
                  {summary.agents.length === 0 ? (
                    <p className="py-4 text-sm text-muted-foreground">No agent runs yet. <Link href="/agents" className="underline underline-offset-2">Create an agent</Link>.</p>
                  ) : (
                    <ul className="divide-y divide-border">
                      {summary.agents.map((a) => (
                        <li key={a.id}>
                          <Link href={a.href} className="flex items-center gap-3 py-2 hover:bg-secondary/40 rounded-md -mx-1 px-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-sm font-medium">{a.agent}</span>
                              <span className="block text-xs text-muted-foreground">{new Date(a.createdAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>
                            </span>
                            <StatusPill status={a.status} map={{ done: "success", running: "info", queued: "neutral", awaiting_approval: "warning", failed: "danger", cancelled: "neutral" }} />
                          </Link>
                        </li>
                      ))}
                    </ul>
                  )}
                </Card>
              )}

              {!summary.empty && !summary.demo.active && (
                <p className="text-xs text-muted-foreground">
                  Want to see every feature populated?{" "}
                  <button type="button" onClick={() => void seed()} disabled={busy !== null} className="underline underline-offset-2 hover:text-foreground disabled:opacity-50">
                    Load sample data
                  </button>
                </p>
              )}
            </div>
          </div>
        </div>
      )}
    </PageContainer>
  );
}

function KpiCard({ tile }: { tile: KpiTile }) {
  const Icon = tile.deltaPct === null || tile.deltaPct === undefined ? null : tile.deltaPct >= 0 ? ArrowUpRight : ArrowDownRight;
  const body = (
    <>
      <p className="truncate text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{tile.label}</p>
      <p className="mt-1 truncate text-xl font-semibold tabular-nums sm:text-2xl">{tile.value}</p>
      {tile.hint && (
        <p className={cn("mt-1 flex items-center gap-1 truncate text-xs", TONE_TEXT[tile.tone ?? "neutral"])}>
          {Icon && <Icon className="h-3 w-3 shrink-0" aria-hidden />}
          {tile.hint}
        </p>
      )}
    </>
  );
  const cls = "block min-w-0 rounded-xl border border-border bg-card p-3 sm:p-4 transition-colors hover:border-foreground/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
  return tile.href ? <Link href={tile.href} className={cls}>{body}</Link> : <div className={cls}>{body}</div>;
}

function Card({ title, icon, count, children }: { title: string; icon: React.ReactNode; count?: number; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-border bg-card p-4" aria-label={title}>
      <header className="mb-2 flex items-center gap-2">
        <span className="text-muted-foreground" aria-hidden>{icon}</span>
        <h2 className="text-sm font-semibold">{title}</h2>
        {typeof count === "number" && count > 0 && <Pill tone="neutral" className="ml-auto">{count}</Pill>}
      </header>
      {children}
    </section>
  );
}

function CashflowCard({ data }: { data: HomeSummary["cashflow"] & object }) {
  const values = data.points.map((p) => p.balance);
  const scaled = sparklineScale(values);
  const W = 240;
  const H = 56;
  const pts = scaled.map((v, i) => `${(i / Math.max(1, scaled.length - 1)) * W},${H - 4 - v * (H - 8)}`).join(" ");
  const last = values[values.length - 1] ?? 0;
  const first = values[0] ?? 0;
  const fmt = (n: number) => {
    try {
      return new Intl.NumberFormat(undefined, { style: "currency", currency: data.currency, notation: "compact", maximumFractionDigits: 1 }).format(n / 100);
    } catch {
      return String(Math.round(n / 100));
    }
  };
  return (
    <Card title="Cash-flow forecast" icon={<Timer className="h-4 w-4" />}>
      <p className="text-xs text-muted-foreground">Projected balance over the next {data.points.length} weeks (relative to today).</p>
      <svg viewBox={`0 0 ${W} ${H}`} className="mt-2 h-14 w-full" role="img" aria-label={`Cash-flow sparkline ending at ${fmt(last)}`}>
        <polyline fill="none" stroke="currentColor" strokeWidth="2" className={last >= first ? "text-emerald-600" : "text-red-600"} points={pts} />
      </svg>
      <div className="mt-1 flex items-center justify-between text-xs">
        <span className="text-muted-foreground">{data.points[0]?.weekStart}</span>
        <span className="font-medium tabular-nums">{fmt(last)}</span>
      </div>
      <Link href="/insights" className="mt-2 inline-block text-xs underline underline-offset-2 hover:text-foreground">Open insights</Link>
    </Card>
  );
}

function SetupChecklist({ status, onDismiss }: { status: OnboardingStatusDTO; onDismiss: () => void }) {
  const c = status.checklist;
  return (
    <section className="rounded-xl border border-primary/30 bg-primary/5 p-4" aria-labelledby="setup-heading">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 id="setup-heading" className="text-sm font-semibold">Finish setup</h2>
          <p className="text-xs text-muted-foreground">{c.done} of {c.total} done</p>
        </div>
        {status.canEdit && (
          <button type="button" onClick={onDismiss} aria-label="Dismiss setup checklist" className="-m-1.5 inline-flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <X className="h-4 w-4" aria-hidden />
          </button>
        )}
      </div>
      <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-secondary" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={c.progress} aria-label="Setup progress">
        <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${c.progress}%` }} />
      </div>
      <ul className="mt-3 grid gap-1.5 sm:grid-cols-2 lg:grid-cols-4">
        {c.items.map((it) => (
          <li key={it.key}>
            <Link href={it.href} className={cn("flex items-start gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-background/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", it.done && "text-muted-foreground")}>
              <CheckCircle2 className={cn("mt-0.5 h-4 w-4 shrink-0", it.done ? "text-emerald-600" : "text-muted-foreground/40")} aria-hidden />
              <span className="min-w-0">
                <span className={cn("block", it.done && "line-through")}>{it.label}</span>
                <span className="block truncate text-xs text-muted-foreground">{it.description}</span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

function QuickActions() {
  const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
  const actions = [
    { href: "/billing?new=quote", label: "New quote", icon: FilePlus2 },
    { href: "/crm?new=contact", label: "New contact", icon: UserPlus },
    { href: "/helpdesk?new=ticket", label: "New ticket", icon: LifeBuoy },
    { href: "/finance?timer=start", label: "Start timer", icon: Timer },
  ];
  return (
    <>
      {actions.map((a) => (
        <Button key={a.href} variant="outline" size="sm" asChild>
          <Link href={a.href}><a.icon className="mr-1.5 h-3.5 w-3.5" aria-hidden />{a.label}</Link>
        </Button>
      ))}
      <span className="hidden items-center gap-1 text-xs text-muted-foreground sm:inline-flex" title="Open the command palette">
        <Command className="h-3.5 w-3.5" aria-hidden /> {isMac ? "⌘" : "Ctrl"}+K to search
      </span>
    </>
  );
}

function DashboardSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading dashboard">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-7">
        {Array.from({ length: 7 }).map((_, i) => <Skeleton key={i} className="h-24 rounded-xl" />)}
      </div>
      <div className="grid gap-6 lg:grid-cols-3">
        <Skeleton className="h-64 rounded-xl lg:col-span-2" />
        <Skeleton className="h-64 rounded-xl" />
      </div>
    </div>
  );
}
