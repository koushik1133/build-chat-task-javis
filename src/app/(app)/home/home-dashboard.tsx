"use client";

import { memo, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle, ArrowDownRight, ArrowRight, ArrowUpRight, Bot, CalendarDays, CheckCircle2, ChevronRight, Command, Database,
  FilePlus2, LayoutDashboard, LifeBuoy, Loader2, Minus, RefreshCw, Sparkles, Timer, TrendingUp, UserPlus, X, Zap,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { PageContainer } from "@/components/page-container";
import { Button } from "@/components/ui/button";
import { Dialog, DialogFooter } from "@/components/ui/dialog";
import { Banner, Empty, ErrorState, Skeleton } from "@/components/ui/feedback";
import { Pill, StatusPill, type Tone } from "@/components/ui/pill";
import { isAbortError, useAbortable } from "@/components/ui/hooks";
import { cn } from "@/lib/utils";
import { sparklineScale, type AgentRunItem, type HomeSummary, type KpiTile, type NeedsYouItem, type TimelineItem } from "@/lib/home/kpis";
import type { Checklist } from "@/lib/onboarding/checklist";

/* ── types & helpers ───────────────────────────────────────────────────── */

interface OnboardingStatusDTO {
  completedAt: string | null;
  checklistDismissed: boolean;
  checklist: Checklist;
  canEdit: boolean;
}

type Notice = { tone: "success" | "error"; text: string };

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

/** What each "needs you" kind is, and the verb that resolves it. */
const NEEDS: Record<NeedsYouItem["kind"], { label: string; cta: string; tone: Tone }> = {
  approval: { label: "Approval", cta: "Review", tone: "violet" },
  sla: { label: "Response due", cta: "Reply", tone: "danger" },
  invoice: { label: "Overdue invoice", cta: "Chase", tone: "warning" },
  deal: { label: "Stalled deal", cta: "Follow up", tone: "info" },
  task: { label: "Overdue task", cta: "Update", tone: "warning" },
  milestone: { label: "Milestone", cta: "Open project", tone: "accent" },
};

const AGENT_TONES: Record<string, Tone> = { done: "success", running: "info", queued: "neutral", awaiting_approval: "warning", failed: "danger", cancelled: "neutral" };

const QUICK_ACTIONS: ReadonlyArray<{ href: string; label: string; text: string; icon: LucideIcon }> = [
  { href: "/billing?new=quote", label: "New quote", text: "Price a job and send it for e-signature.", icon: FilePlus2 },
  { href: "/crm?new=contact", label: "New contact", text: "Add a customer, lead or supplier.", icon: UserPlus },
  { href: "/helpdesk?new=ticket", label: "New ticket", text: "Log a support request by hand.", icon: LifeBuoy },
  { href: "/finance?timer=start", label: "Start timer", text: "Track time against a job.", icon: Timer },
];

const linkCls = "inline-flex min-h-11 items-center rounded text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-0";

function fmtTime(iso: string, tz: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", timeZone: tz }).format(new Date(iso));
  } catch {
    return new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }
}

function fmtWhen(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function greeting(now: Date): string {
  const h = now.getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

/* ── page ──────────────────────────────────────────────────────────────── */

export function HomeDashboard({ firstName }: { firstName: string | null }) {
  const [summary, setSummary] = useState<HomeSummary | null>(null);
  const [status, setStatus] = useState<OnboardingStatusDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState<"seed" | "clear" | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  // The clock is read after mount so server and client never disagree on the greeting.
  const [now, setNow] = useState<Date | null>(null);
  const nextSignal = useAbortable();

  useEffect(() => {
    setNow(new Date());
    const t = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(t);
  }, []);

  const load = useCallback(async () => {
    const signal = nextSignal();
    setError(null);
    setRefreshing(true);
    try {
      const [a, b] = await Promise.all([
        fetch("/api/home/summary", { signal, cache: "no-store" }),
        fetch("/api/onboarding/status", { signal, cache: "no-store" }),
      ]);
      if (!a.ok) throw new Error(await readError(a, "Could not load your dashboard"));
      setSummary((await a.json()) as HomeSummary);
      setStatus(b.ok ? ((await b.json()) as OnboardingStatusDTO) : null);
    } catch (err) {
      if (isAbortError(err)) return;
      setError(err instanceof Error ? err.message : "Could not load your dashboard");
    } finally {
      if (!signal.aborted) setRefreshing(false);
    }
  }, [nextSignal]);

  useEffect(() => {
    void load();
  }, [load]);

  const seed = async () => {
    setBusy("seed");
    setNotice(null);
    try {
      const res = await fetch("/api/demo/seed", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      if (!res.ok) throw new Error(await readError(res, "Could not load sample data"));
      const d = (await res.json()) as { seeded: boolean };
      setNotice({ tone: "success", text: d.seeded ? "Sample data loaded. Explore every module, then clear it from the banner above when you're ready." : "Sample data was already loaded." });
      await load();
    } catch (err) {
      setNotice({ tone: "error", text: err instanceof Error ? err.message : "Could not load sample data" });
    } finally {
      setBusy(null);
    }
  };

  const clear = async () => {
    setBusy("clear");
    setNotice(null);
    try {
      const res = await fetch("/api/demo/clear", { method: "DELETE" });
      if (!res.ok) throw new Error(await readError(res, "Could not clear sample data"));
      setConfirmClear(false);
      setNotice({ tone: "success", text: "Sample data removed. Your own records are untouched." });
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

  const title = now ? (firstName ? `${greeting(now)}, ${firstName}` : greeting(now)) : firstName ? `Hello, ${firstName}` : "Home";
  const dateLine = now ? now.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" }) : "Your day at a glance";
  const attention = summary?.needsYou?.length ?? 0;
  const description = attention > 0 ? `${dateLine} · ${attention} item${attention === 1 ? "" : "s"} need${attention === 1 ? "s" : ""} you` : dateLine;
  const showChecklist = Boolean(status && !status.checklistDismissed && !status.checklist.complete);

  // Which cards exist drives the grid so role-gated (null) sections never leave holes.
  const hasMain = Boolean(summary && (summary.needsYou || summary.today));
  const hasSide = Boolean(summary && (summary.cashflow || summary.agents));

  return (
    <PageContainer
      wide
      title={title}
      description={description}
      icon={<LayoutDashboard className="h-5 w-5" />}
      className="pb-24"
      actions={
        <>
          <Button variant="outline" size="icon" touch onClick={() => void load()} disabled={refreshing} aria-label="Refresh dashboard">
            {refreshing ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden /> : <RefreshCw className="h-4 w-4" aria-hidden />}
          </Button>
          <Button touch asChild>
            <Link href="/billing?new=quote">
              <FilePlus2 className="h-4 w-4" aria-hidden /> New quote
            </Link>
          </Button>
        </>
      }
    >
      {notice && <Banner tone={notice.tone} onDismiss={() => setNotice(null)}>{notice.text}</Banner>}
      {error && summary && <Banner tone="error" onDismiss={() => setError(null)}>{error}</Banner>}

      {summary?.demo.active && (
        <Banner tone="info">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="inline-flex items-start gap-2">
              <Database className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              <span>
                <span className="font-medium">You&apos;re looking at sample data</span> ({summary.demo.rows} rows). Everything tagged as demo can be removed in one go; your own records stay.
              </span>
            </span>
            <Button size="sm" variant="outline" touch onClick={() => setConfirmClear(true)} disabled={busy !== null}>
              <X className="h-3.5 w-3.5" aria-hidden /> Clear sample data
            </Button>
          </div>
        </Banner>
      )}

      {error && !summary && <ErrorState message={error} onRetry={() => void load()} />}
      {!error && !summary && <DashboardSkeleton />}

      {summary && (
        <div className="space-y-6" aria-busy={refreshing || undefined}>
          {showChecklist && status && <SetupChecklist status={status} onDismiss={dismissChecklist} />}

          {summary.empty && !summary.demo.active && (
            <Empty
              icon={<Sparkles className="h-5 w-5" />}
              title="Your workspace is ready"
              text="Add your first contact or quote, or look around with realistic sample data that you can remove at any time."
              action={
                <>
                  <Button touch onClick={() => void seed()} disabled={busy !== null}>
                    {busy === "seed" ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden /> : <Database className="h-4 w-4" aria-hidden />} Explore with sample data
                  </Button>
                  <Button variant="outline" touch asChild>
                    <Link href="/onboarding">Set up my business</Link>
                  </Button>
                </>
              }
            />
          )}

          {summary.kpis && summary.kpis.length > 0 && (
            <section aria-labelledby="kpi-heading">
              <h2 id="kpi-heading" className="sr-only">Key numbers</h2>
              <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-[repeat(auto-fit,minmax(10rem,1fr))]">
                {summary.kpis.map((k) => (
                  <li key={k.key} className="min-w-0">
                    <KpiCard tile={k} />
                  </li>
                ))}
              </ul>
            </section>
          )}

          {(hasMain || hasSide) && (
            <div className={cn("grid gap-6", hasMain && hasSide && "lg:grid-cols-3")}>
              {hasMain && (
                <div className={cn("min-w-0 space-y-6", hasSide && "lg:col-span-2")}>
                  {summary.needsYou && <NeedsYouCard items={summary.needsYou} />}
                  {summary.today && <TodayCard items={summary.today} tz={summary.timezone} now={now} />}
                </div>
              )}

              <div className={cn("min-w-0 space-y-6", !hasMain && "lg:grid lg:grid-cols-3 lg:gap-6 lg:space-y-0")}>
                {summary.cashflow && summary.cashflow.points.length > 1 && <CashflowCard data={summary.cashflow} />}
                {summary.agents && <AgentsCard runs={summary.agents} />}
                <QuickActionsCard />
                {!summary.empty && !summary.demo.active && (
                  <p className="text-xs text-muted-foreground">
                    Want to see every module populated?{" "}
                    <button type="button" onClick={() => void seed()} disabled={busy !== null} className="inline-flex min-h-11 items-center rounded underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 sm:min-h-0">
                      Load sample data
                    </button>
                  </p>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {confirmClear && (
        <Dialog title="Remove all sample data?" description="Every record tagged as demo is deleted. Anything you created yourself is kept." onClose={() => busy === null && setConfirmClear(false)} size="sm">
          <DialogFooter>
            <Button variant="ghost" touch onClick={() => setConfirmClear(false)} disabled={busy !== null}>Keep it</Button>
            <Button variant="destructive" touch onClick={() => void clear()} disabled={busy !== null}>
              {busy === "clear" && <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />} Remove sample data
            </Button>
          </DialogFooter>
        </Dialog>
      )}
    </PageContainer>
  );
}

/* ── cards ─────────────────────────────────────────────────────────────── */

function Card({ title, icon, count, action, children, className }: { title: string; icon: React.ReactNode; count?: number; action?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={cn("min-w-0 rounded-xl border border-border bg-card p-4 sm:p-5", className)} aria-label={title}>
      <header className="mb-3 flex items-center gap-2">
        <span className="text-muted-foreground" aria-hidden>{icon}</span>
        <h2 className="text-sm font-semibold">{title}</h2>
        {typeof count === "number" && count > 0 && <Pill tone="neutral" className="tabular-nums">{count}</Pill>}
        {action && <span className="ml-auto">{action}</span>}
      </header>
      {children}
    </section>
  );
}

const KpiCard = memo(function KpiCard({ tile }: { tile: KpiTile }) {
  const delta = tile.deltaPct ?? null;
  const Icon = delta === null ? null : delta > 0 ? ArrowUpRight : delta < 0 ? ArrowDownRight : Minus;
  const body = (
    <>
      <p className="truncate text-xs font-medium text-muted-foreground">{tile.label}</p>
      <p className="mt-1.5 truncate text-2xl font-semibold tabular-nums tracking-tight">{tile.value}</p>
      {tile.hint && (
        <p className={cn("mt-1 flex min-w-0 items-center gap-1 text-xs", TONE_TEXT[tile.tone ?? "neutral"])}>
          {Icon && <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />}
          <span className="truncate">{tile.hint}</span>
        </p>
      )}
    </>
  );
  const cls = "block h-full min-w-0 rounded-xl border border-border bg-card p-4 transition-colors motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
  return tile.href ? (
    <Link href={tile.href} className={cn(cls, "hover:border-foreground/25 hover:bg-secondary/30")} aria-label={`${tile.label}: ${tile.value}${tile.hint ? `, ${tile.hint}` : ""}. Open module`}>
      {body}
    </Link>
  ) : (
    <div className={cls}>{body}</div>
  );
});

const NeedsYouCard = memo(function NeedsYouCard({ items }: { items: NeedsYouItem[] }) {
  return (
    <Card title="Needs you" icon={<AlertTriangle className="h-4 w-4" />} count={items.length} className={items.length > 0 ? "border-amber-500/30" : undefined}>
      {items.length === 0 ? (
        <p className="flex items-center gap-2 py-6 text-sm text-muted-foreground" role="status">
          <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" aria-hidden /> Nothing is waiting on you right now.
        </p>
      ) : (
        <ul className="-mx-2 divide-y divide-border">
          {items.map((n) => {
            const meta = NEEDS[n.kind];
            return (
              <li key={`${n.kind}:${n.id}`} className="flex items-center gap-3 px-2 py-2.5">
                <Pill tone={meta.tone} className="hidden shrink-0 sm:inline-flex">{meta.label}</Pill>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{n.title}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    <span className="sm:hidden">{meta.label} · </span>
                    {n.detail}
                  </p>
                </div>
                <Button size="sm" variant="outline" touch asChild>
                  <Link href={n.href} aria-label={`${meta.cta}: ${n.title}`}>
                    {meta.cta} <ArrowRight className="h-3.5 w-3.5" aria-hidden />
                  </Link>
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
});

const TodayCard = memo(function TodayCard({ items, tz, now }: { items: TimelineItem[]; tz: string; now: Date | null }) {
  const nowMs = now?.getTime() ?? 0;
  return (
    <Card title="Today" icon={<CalendarDays className="h-4 w-4" />} count={items.length} action={<Link href="/calendar" className={linkCls}>Open calendar</Link>}>
      {items.length === 0 ? (
        <p className="py-6 text-sm text-muted-foreground">No bookings or due items today. A clear run — a good time to follow up on open quotes.</p>
      ) : (
        <ol className="relative -mx-2 before:absolute before:bottom-3 before:left-[5.05rem] before:top-3 before:w-px before:bg-border sm:before:left-[5.55rem]">
          {items.map((t) => {
            const past = t.at ? nowMs > 0 && new Date(t.at).getTime() < nowMs : false;
            return (
              <li key={`${t.kind}:${t.id}`}>
                <Link href={t.href} className={cn("flex items-center gap-3 rounded-md px-2 py-2.5 hover:bg-secondary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:py-2", past && "opacity-60")}>
                  <span className="w-14 shrink-0 text-right text-xs tabular-nums text-muted-foreground sm:w-16">{t.at ? fmtTime(t.at, tz) : "Any time"}</span>
                  <span className={cn("relative z-10 h-2.5 w-2.5 shrink-0 rounded-full ring-4 ring-card", t.kind === "booking" ? "bg-primary" : "bg-amber-500")} aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">{t.title}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {t.kind === "booking" ? "Booking" : "Due"}
                      {t.detail ? ` · ${t.detail}` : ""}
                    </span>
                  </span>
                  <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                </Link>
              </li>
            );
          })}
        </ol>
      )}
    </Card>
  );
});

const AgentsCard = memo(function AgentsCard({ runs }: { runs: AgentRunItem[] }) {
  const active = runs.filter((r) => r.status === "running" || r.status === "queued").length;
  return (
    <Card title="Agents working" icon={<Bot className="h-4 w-4" />} count={active} action={<Link href="/agents" className={linkCls}>All agents</Link>}>
      {runs.length === 0 ? (
        <Empty className="py-6" title="No agent runs yet" text="Agents research, draft and follow up for you." action={<Button size="sm" variant="outline" touch asChild><Link href="/agents">Create an agent</Link></Button>} />
      ) : (
        <ul className="-mx-2 divide-y divide-border">
          {runs.map((a) => (
            <li key={a.id}>
              <Link href={a.href} className="flex min-h-11 items-center gap-3 rounded-md px-2 py-2 hover:bg-secondary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{a.agent}</span>
                  <span className="block text-xs text-muted-foreground">{fmtWhen(a.createdAt)}</span>
                </span>
                <StatusPill status={a.status} map={AGENT_TONES} />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
});

function QuickActionsCard() {
  const [isMac, setIsMac] = useState(false);
  useEffect(() => {
    setIsMac(/Mac|iPhone|iPad/.test(navigator.platform));
  }, []);
  return (
    <Card title="Quick actions" icon={<Zap className="h-4 w-4" />}>
      <ul className="grid grid-cols-2 gap-2">
        {QUICK_ACTIONS.map((a) => (
          <li key={a.href}>
            <Link href={a.href} className="flex h-full min-h-11 flex-col gap-1 rounded-lg border border-border p-3 text-sm transition-colors hover:border-foreground/25 hover:bg-secondary/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none">
              <span className="flex items-center gap-2 font-medium">
                <a.icon className="h-4 w-4 text-primary" aria-hidden /> {a.label}
              </span>
              <span className="text-xs text-muted-foreground">{a.text}</span>
            </Link>
          </li>
        ))}
      </ul>
      <p className="mt-3 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
        <Command className="h-3.5 w-3.5" aria-hidden /> Press <kbd className="rounded border border-border bg-secondary px-1 font-sans text-[11px]">{isMac ? "⌘" : "Ctrl"}</kbd>+<kbd className="rounded border border-border bg-secondary px-1 font-sans text-[11px]">K</kbd> to search anything.
      </p>
    </Card>
  );
}

/* ── cash-flow sparkline ───────────────────────────────────────────────── */

function CashflowCard({ data }: { data: NonNullable<HomeSummary["cashflow"]> }) {
  const values = useMemo(() => data.points.map((p) => p.balance), [data.points]);
  const labels = useMemo(() => data.points.map((p) => p.weekStart), [data.points]);
  const fmt = useCallback(
    (n: number) => {
      try {
        return new Intl.NumberFormat(undefined, { style: "currency", currency: data.currency, notation: "compact", maximumFractionDigits: 1 }).format(n / 100);
      } catch {
        return String(Math.round(n / 100));
      }
    },
    [data.currency]
  );
  const first = values[0] ?? 0;
  const last = values[values.length - 1] ?? 0;
  const change = last - first;
  const trend = change > 0 ? "up" : change < 0 ? "down" : "flat";
  const TrendIcon = trend === "up" ? ArrowUpRight : trend === "down" ? ArrowDownRight : Minus;

  return (
    <Card title="Cash-flow forecast" icon={<TrendingUp className="h-4 w-4" />} action={<Link href="/insights" className={linkCls}>Open insights</Link>}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <p className="text-2xl font-semibold tabular-nums tracking-tight">{fmt(last)}</p>
        <p className={cn("flex items-center gap-1 text-xs", trend === "up" ? TONE_TEXT.good : trend === "down" ? TONE_TEXT.bad : TONE_TEXT.neutral)}>
          <TrendIcon className="h-3.5 w-3.5" aria-hidden />
          {trend === "flat" ? "No change" : `${change > 0 ? "+" : "−"}${fmt(Math.abs(change))}`} over {values.length} weeks
        </p>
      </div>
      <p className="mt-0.5 text-xs text-muted-foreground">Projected balance, relative to today. Moves as invoices are sent and paid.</p>
      <Sparkline values={values} labels={labels} fmt={fmt} />
    </Card>
  );
}

/**
 * Single-series sparkline: 2px line, soft area to the baseline, an 8px marker on
 * the last point, and a hover/keyboard crosshair that reads out the week under it.
 * A visually hidden table carries the same numbers for assistive tech.
 */
function Sparkline({ values, labels, fmt }: { values: number[]; labels: string[]; fmt: (n: number) => string }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 320;
  const H = 72;
  const PAD = 6;
  const pts = useMemo(() => {
    const scaled = sparklineScale(values);
    return scaled.map((v, i) => ({ x: PAD + (i / Math.max(1, scaled.length - 1)) * (W - PAD * 2), y: PAD + (1 - v) * (H - PAD * 2) }));
  }, [values]);
  if (pts.length < 2) return null;
  const line = pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  const area = `${PAD},${H} ${line} ${pts[pts.length - 1].x.toFixed(1)},${H}`;
  const end = pts[pts.length - 1];
  const idx = hover ?? pts.length - 1;
  const cur = pts[idx];
  const gradId = `spark-fill-${labels[0]}`;
  const min = Math.min(...values);
  const max = Math.max(...values);

  function onMove(e: React.PointerEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * W;
    let best = 0;
    for (let i = 1; i < pts.length; i++) if (Math.abs(pts[i].x - x) < Math.abs(pts[best].x - x)) best = i;
    setHover(best);
  }
  function onKey(e: React.KeyboardEvent<SVGSVGElement>) {
    if (e.key === "ArrowRight") { e.preventDefault(); setHover(Math.min(pts.length - 1, idx + 1)); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); setHover(Math.max(0, idx - 1)); }
    else if (e.key === "Home") { e.preventDefault(); setHover(0); }
    else if (e.key === "End") { e.preventDefault(); setHover(pts.length - 1); }
  }

  return (
    <figure className="mt-3">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="h-[4.5rem] w-full touch-pan-y rounded text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        role="img"
        tabIndex={0}
        aria-label={`Projected balance by week, from ${fmt(values[0])} to ${fmt(values[values.length - 1])}. Lowest ${fmt(min)}, highest ${fmt(max)}. Use the arrow keys to read each week.`}
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
        onBlur={() => setHover(null)}
        onKeyDown={onKey}
      >
        <defs>
          <linearGradient id={gradId} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="currentColor" stopOpacity="0.18" />
            <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
          </linearGradient>
        </defs>
        <polygon points={area} fill={`url(#${gradId})`} />
        <polyline points={line} fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        {hover !== null && <line x1={cur.x} x2={cur.x} y1={PAD} y2={H - PAD} stroke="currentColor" strokeOpacity="0.35" strokeDasharray="2 3" vectorEffect="non-scaling-stroke" />}
        <circle cx={end.x} cy={end.y} r="4" fill="currentColor" stroke="hsl(var(--card))" strokeWidth="2" />
        {hover !== null && hover !== pts.length - 1 && <circle cx={cur.x} cy={cur.y} r="4" fill="currentColor" stroke="hsl(var(--card))" strokeWidth="2" />}
      </svg>
      <figcaption className="mt-1 flex items-center justify-between gap-2 text-xs" aria-live="polite">
        <span className="text-muted-foreground">Week of {labels[hover === null ? 0 : idx]}</span>
        <span className="font-medium tabular-nums">{hover === null ? `${fmt(values[values.length - 1])} by ${labels[labels.length - 1]}` : fmt(values[idx])}</span>
      </figcaption>
      <table className="sr-only">
        <caption>Projected balance by week</caption>
        <thead><tr><th scope="col">Week starting</th><th scope="col">Balance</th></tr></thead>
        <tbody>{values.map((v, i) => <tr key={labels[i]}><td>{labels[i]}</td><td>{fmt(v)}</td></tr>)}</tbody>
      </table>
    </figure>
  );
}

/* ── setup checklist ───────────────────────────────────────────────────── */

function SetupChecklist({ status, onDismiss }: { status: OnboardingStatusDTO; onDismiss: () => void }) {
  const c = status.checklist;
  const nextItem = c.items.find((i) => !i.done);
  return (
    <section className="rounded-xl border border-primary/30 bg-accent/60 p-4 sm:p-5" aria-labelledby="setup-heading">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id="setup-heading" className="text-sm font-semibold">Finish setting up</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {c.done} of {c.total} done{nextItem ? ` · next: ${nextItem.label}` : ""}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {nextItem && (
            <Button size="sm" touch asChild className="hidden sm:inline-flex">
              <Link href={nextItem.href}>{nextItem.label} <ArrowRight className="h-3.5 w-3.5" aria-hidden /></Link>
            </Button>
          )}
          {status.canEdit && (
            <button type="button" onClick={onDismiss} aria-label="Hide setup checklist" className="-m-1 inline-flex h-11 w-11 items-center justify-center rounded-md text-muted-foreground hover:bg-background/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:h-9 sm:w-9">
              <X className="h-4 w-4" aria-hidden />
            </button>
          )}
        </div>
      </div>
      <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-background/80" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={c.progress} aria-label="Setup progress">
        <div className="h-full rounded-full bg-primary transition-[width] duration-500 motion-reduce:transition-none" style={{ width: `${c.progress}%` }} />
      </div>
      <ul className="mt-3 grid gap-1 sm:grid-cols-2 lg:grid-cols-4">
        {c.items.map((it) => (
          <li key={it.key}>
            <Link href={it.href} className={cn("flex min-h-11 items-start gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-background/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", it.done && "text-muted-foreground")}>
              <CheckCircle2 className={cn("mt-0.5 h-4 w-4 shrink-0", it.done ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground/40")} aria-hidden />
              <span className="min-w-0">
                <span className={cn("block", it.done && "line-through")}>{it.label}</span>
                <span className="block truncate text-xs text-muted-foreground">{it.description}</span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
      {nextItem && (
        <Button size="sm" touch asChild className="mt-3 w-full sm:hidden">
          <Link href={nextItem.href}>{nextItem.label} <ArrowRight className="h-3.5 w-3.5" aria-hidden /></Link>
        </Button>
      )}
    </section>
  );
}

/* ── skeleton (mirrors the loaded layout so nothing jumps) ─────────────── */

function DashboardSkeleton() {
  return (
    <div className="space-y-6" role="status" aria-busy="true" aria-label="Loading dashboard">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-7">
        {Array.from({ length: 7 }).map((_, i) => (
          <div key={i} className="rounded-xl border border-border bg-card p-4">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="mt-3 h-7 w-24" />
            <Skeleton className="mt-2 h-3 w-16" />
          </div>
        ))}
      </div>
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <div className="rounded-xl border border-border bg-card p-4 sm:p-5">
            <Skeleton className="h-4 w-24" />
            <div className="mt-4 space-y-3">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="flex items-center gap-3">
                  <Skeleton className="hidden h-5 w-16 rounded-full sm:block" />
                  <div className="flex-1 space-y-1.5"><Skeleton className="h-3.5 w-3/4" /><Skeleton className="h-3 w-1/2" /></div>
                  <Skeleton className="h-8 w-20" />
                </div>
              ))}
            </div>
          </div>
          <div className="rounded-xl border border-border bg-card p-4 sm:p-5">
            <Skeleton className="h-4 w-16" />
            <div className="mt-4 space-y-3">
              {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-9 w-full" />)}
            </div>
          </div>
        </div>
        <div className="space-y-6">
          <div className="rounded-xl border border-border bg-card p-4 sm:p-5">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="mt-3 h-7 w-28" />
            <Skeleton className="mt-3 h-[4.5rem] w-full" />
          </div>
          <div className="rounded-xl border border-border bg-card p-4 sm:p-5">
            <Skeleton className="h-4 w-28" />
            <div className="mt-4 space-y-3">
              {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-8 w-full" />)}
            </div>
          </div>
        </div>
      </div>
      <span className="sr-only">Loading your dashboard…</span>
    </div>
  );
}
