"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Lightbulb, Loader2, Plus, RefreshCw, Sparkles, Trash2, TrendingUp, Users, Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { Field } from "@/components/ui/field";
import { Tabs, TabPanel } from "@/components/ui/tabs";
import { Banner, Empty, ErrorState, Loading } from "@/components/ui/feedback";
import { Pill } from "@/components/ui/pill";
import { TableScroller, TH, THEAD } from "@/components/ui/table-scroller";
import { isAbortError, useAbortable } from "@/components/ui/hooks";
import { PageContainer } from "@/components/page-container";
import { BandChart, CashflowChart, UtilisationChart, VIZ_STYLE } from "@/components/insights/charts";
import { fmtMoney } from "@/lib/money/format";
import { cn } from "@/lib/utils";
import type { CashflowForecast } from "@/lib/optimize/cashflow";
import type { CapacityPlan } from "@/lib/optimize/capacity";
import type { PricingSuggestion } from "@/lib/optimize/pricing";

type Tab = "cashflow" | "capacity" | "pricing";
interface Narrative { summary: string; actions: string[] }
type NarrativeState = { status: "idle" | "loading" | "ready" | "unavailable" | "error"; narrative: Narrative | null; message?: string };

const TABS = [
  { id: "cashflow" as const, label: "Cash flow" },
  { id: "capacity" as const, label: "Capacity" },
  { id: "pricing" as const, label: "Pricing" },
];
const spinner = <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />;
const pct = (v: number) => `${Math.round(v * 100)}%`;
const hrs = (min: number) => `${Math.round(min / 60)}h`;

/** Fetch an optimize endpoint. A 503/402/502 still carries the data; the narrative is reported separately. */
async function fetchOptimize<T>(path: string, key: string, init?: RequestInit, signal?: AbortSignal): Promise<{ data: T; narrative: NarrativeState }> {
  const res = await fetch(path, { ...init, signal, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } });
  const body = await res.json().catch(() => null);
  const data = body?.[key] as T | undefined;
  if (!data) {
    const fieldErr = body?.detail?.fieldErrors ? Object.entries(body.detail.fieldErrors as Record<string, string[]>).map(([k, v]) => `${k}: ${v.join(", ")}`)[0] : null;
    throw new Error(body?.detail?.formErrors?.[0] ?? fieldErr ?? (typeof body?.detail === "string" ? body.detail : null) ?? body?.error ?? `Request failed (${res.status})`);
  }
  let narrative: NarrativeState;
  if (body.narrative) narrative = { status: "ready", narrative: body.narrative as Narrative };
  else if (res.status === 503) narrative = { status: "unavailable", narrative: null, message: "AI narration is not configured. Set GROQ_API_KEY or GEMINI_API_KEY to enable it." };
  else if (res.status === 402) narrative = { status: "unavailable", narrative: null, message: body?.detail ?? "AI budget exhausted for this month." };
  else if (!res.ok) narrative = { status: "error", narrative: null, message: "The AI summary could not be generated. The numbers below are unaffected." };
  else narrative = { status: "idle", narrative: null };
  return { data, narrative };
}

export default function InsightsPage() {
  const [tab, setTab] = useState<Tab>("cashflow");
  return (
    <PageContainer
      wide
      title="Insights"
      description="Forecasts and suggestions computed from your own invoices, expenses, bookings and quotes — with an optional plain-language summary."
      tooltip="Cash flow forecasts the next weeks from receivables and spend. Capacity compares booked and logged work with your availability. Pricing learns from which quotes were accepted or declined."
    >
      <style dangerouslySetInnerHTML={{ __html: VIZ_STYLE }} />
      <Tabs id="insights" tabs={TABS} value={tab} onChange={setTab} label="Insight type" className="mb-5 w-fit" />
      <TabPanel id="insights" value={tab}>
        {tab === "cashflow" && <CashflowTab />}
        {tab === "capacity" && <CapacityTab />}
        {tab === "pricing" && <PricingTab />}
      </TabPanel>
    </PageContainer>
  );
}

function NarrativeCard({ state, onGenerate, busy }: { state: NarrativeState; onGenerate: () => void; busy: boolean }) {
  return (
    <section aria-labelledby="narrative-heading" className="rounded-xl border border-border bg-card p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h2 id="narrative-heading" className="flex items-center gap-2 text-sm font-semibold">
          <Sparkles className="h-4 w-4 text-primary" aria-hidden /> What this means
        </h2>
        <Button size="sm" variant="outline" touch onClick={onGenerate} disabled={busy || state.status === "loading"}>
          {state.status === "loading" ? spinner : <Sparkles className="h-3.5 w-3.5" aria-hidden />}
          {state.narrative ? "Regenerate" : "Explain with AI"}
        </Button>
      </div>
      {state.status === "loading" ? (
        <Loading className="py-6" label="Writing the summary…" />
      ) : state.narrative ? (
        <div className="mt-3">
          <p className="text-sm leading-relaxed">{state.narrative.summary}</p>
          {state.narrative.actions.length > 0 && (
            <ol className="mt-3 space-y-2">
              {state.narrative.actions.map((a, i) => (
                <li key={i} className="flex items-start gap-2 text-sm">
                  <span className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[11px] font-semibold text-primary" aria-hidden>{i + 1}</span>
                  <span className="sr-only">Action {i + 1}:</span>
                  {a}
                </li>
              ))}
            </ol>
          )}
        </div>
      ) : state.status === "unavailable" || state.status === "error" ? (
        <Banner tone={state.status === "error" ? "error" : "info"} className="mt-3 mb-0">{state.message}</Banner>
      ) : (
        <p className="mt-2 text-sm text-muted-foreground">Get a short plain-language summary with three suggested actions. Uses your AI budget.</p>
      )}
    </section>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "good" | "bad" }) {
  return (
    <div className="rounded-xl border border-border bg-card p-3 sm:p-4">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={cn("mt-1 truncate text-lg font-semibold tabular-nums sm:text-xl", tone === "good" && "text-emerald-700 dark:text-emerald-300", tone === "bad" && "text-red-700 dark:text-red-300")} title={value}>{value}</p>
    </div>
  );
}

// ── Cash flow ────────────────────────────────────────────────────────────────

function CashflowTab() {
  const [weeks, setWeeks] = useState(12);
  const [opening, setOpening] = useState("");
  const [data, setData] = useState<(CashflowForecast & { currency: string }) | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [narrative, setNarrative] = useState<NarrativeState>({ status: "idle", narrative: null });
  const nextSignal = useAbortable();

  const load = useCallback(
    async (narrate: boolean) => {
      const signal = nextSignal();
      setLoading(true);
      setError(null);
      if (narrate) setNarrative({ status: "loading", narrative: null });
      try {
        const openingMinor = Math.round((Number(opening) || 0) * 100);
        const r = await fetchOptimize<CashflowForecast & { currency: string }>(`/api/optimize/cashflow?weeks=${weeks}&opening=${openingMinor}&narrate=${narrate ? 1 : 0}`, "forecast", undefined, signal);
        setData(r.data);
        if (narrate || r.narrative.narrative) setNarrative(r.narrative);
      } catch (e) {
        if (isAbortError(e)) return;
        setError(e instanceof Error ? e.message : "Could not load the forecast.");
        if (narrate) setNarrative({ status: "idle", narrative: null });
      } finally {
        if (!signal.aborted) setLoading(false);
      }
    },
    [nextSignal, weeks, opening]
  );
  useEffect(() => {
    void load(false);
  }, [load]);

  const ccy = data?.currency ?? "USD";
  const s = data?.summary;
  const noData = data?.risks.some((r) => r.kind === "no_data");

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Horizon">
          <Select value={String(weeks)} onChange={(e) => setWeeks(Number(e.target.value))} className="w-36">
            {[4, 8, 12, 26, 52].map((w) => <option key={w} value={w}>{w} weeks</option>)}
          </Select>
        </Field>
        <Field label={`Cash on hand (${ccy})`} hint="Optional. Balances are relative when empty.">
          <Input type="number" inputMode="decimal" step="0.01" value={opening} onChange={(e) => setOpening(e.target.value)} className="w-44" placeholder="0.00" />
        </Field>
        <Button variant="outline" size="icon" touch onClick={() => void load(false)} disabled={loading} aria-label="Refresh forecast">
          {loading ? spinner : <RefreshCw className="h-4 w-4" aria-hidden />}
        </Button>
      </div>
      {error && <Banner tone="error" onDismiss={() => setError(null)}>{error}</Banner>}
      {loading && !data ? (
        <Loading label="Building the forecast…" />
      ) : !data && error ? (
        <ErrorState message={error} onRetry={() => void load(false)} />
      ) : data && s ? (
        <div aria-busy={loading || undefined} className="space-y-5">
          {noData ? (
            <Empty icon={<Wallet className="h-5 w-5" />} title="Nothing to forecast yet" text="Send invoices, log expenses and create quotes — the forecast builds itself from them." />
          ) : (
            <>
              <section aria-label="Summary" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                <Stat label="Open receivables" value={fmtMoney(s.receivablesOpen, ccy)} />
                <Stat label="Overdue" value={fmtMoney(s.receivablesOverdue, ccy)} tone={s.receivablesOverdue > 0 ? "bad" : undefined} />
                <Stat label={`Lowest balance${s.lowestWeek ? ` · ${s.lowestWeek}` : ""}`} value={fmtMoney(s.lowestBalance, ccy)} tone={s.lowestBalance < 0 ? "bad" : "good"} />
                <Stat label={`Ending balance (${weeks}w)`} value={fmtMoney(s.endingBalance, ccy)} tone={s.endingBalance < 0 ? "bad" : "good"} />
              </section>
              <section aria-label="Forecast chart" className="rounded-xl border border-border bg-card p-3 sm:p-4">
                <CashflowChart currency={ccy} points={data.weeks.map((w) => ({ weekStart: w.weekStart, inflowConfirmed: w.inflowConfirmed, inflowExpected: w.inflowExpected, outflow: w.outflowRecurring + w.outflowRunRate, balanceConfirmed: w.balanceConfirmed }))} />
              </section>
              {data.risks.length > 0 && (
                <section aria-labelledby="risks-heading" className="rounded-xl border border-border bg-card p-4 sm:p-5">
                  <h2 id="risks-heading" className="flex items-center gap-2 text-sm font-semibold"><AlertTriangle className="h-4 w-4 text-amber-600" aria-hidden /> Risk flags</h2>
                  <ul className="mt-3 space-y-2">
                    {data.risks.map((r, i) => (
                      <li key={i} className="flex items-start gap-2 text-sm">
                        <Pill tone={r.severity === "serious" ? "danger" : "warning"} className="mt-0.5 shrink-0">{r.severity}</Pill>
                        <span>{r.message}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </>
          )}
          <NarrativeCard state={narrative} onGenerate={() => void load(true)} busy={loading} />
          {!noData && (
            <details className="rounded-xl border border-border bg-card">
              <summary className="cursor-pointer px-4 py-3 text-sm font-semibold">Weekly table and assumptions</summary>
              <div className="space-y-4 px-4 pb-4">
                <TableScroller label="Weekly forecast">
                  <table className="w-full min-w-[40rem] text-sm">
                    <thead className={THEAD}>
                      <tr>
                        <th scope="col" className={TH}>Week</th>
                        <th scope="col" className={cn(TH, "text-right")}>In (confirmed)</th>
                        <th scope="col" className={cn(TH, "text-right")}>In (pipeline)</th>
                        <th scope="col" className={cn(TH, "text-right")}>Out</th>
                        <th scope="col" className={cn(TH, "text-right")}>Balance</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {data.weeks.map((w) => (
                        <tr key={w.weekStart}>
                          <td className="px-3 py-1.5 tabular-nums">{w.weekStart}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums">{fmtMoney(w.inflowConfirmed, ccy)}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">{fmtMoney(w.inflowExpected, ccy)}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums">{fmtMoney(w.outflowRecurring + w.outflowRunRate, ccy)}</td>
                          <td className={cn("px-3 py-1.5 text-right tabular-nums font-medium", w.balanceConfirmed < 0 && "text-red-700 dark:text-red-300")}>{fmtMoney(w.balanceConfirmed, ccy)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableScroller>
                <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
                  <div className="flex justify-between gap-3"><dt className="text-muted-foreground">Typical days to pay</dt><dd className="tabular-nums">{data.assumptions.medianDaysToPay ?? `${data.assumptions.defaultDaysToPay} (default)`}</dd></div>
                  <div className="flex justify-between gap-3"><dt className="text-muted-foreground">Clients with payment history</dt><dd className="tabular-nums">{data.assumptions.contactsWithHistory}</dd></div>
                  <div className="flex justify-between gap-3"><dt className="text-muted-foreground">Weekly run-rate spend</dt><dd className="tabular-nums">{fmtMoney(data.assumptions.weeklyRunRate, ccy)}</dd></div>
                  <div className="flex justify-between gap-3"><dt className="text-muted-foreground">Pipeline weighting</dt><dd className="tabular-nums">draft 15% · sent 40% · viewed 60% · booking 90%</dd></div>
                </dl>
                {data.assumptions.recurring.length > 0 && (
                  <p className="text-sm text-muted-foreground">Recurring: {data.assumptions.recurring.map((r) => `${r.label} ${fmtMoney(r.amount_minor, ccy)} every ${r.everyDays}d`).join(" · ")}</p>
                )}
              </div>
            </details>
          )}
        </div>
      ) : null}
    </div>
  );
}

// ── Capacity ─────────────────────────────────────────────────────────────────

function CapacityTab() {
  const [weeks, setWeeks] = useState(8);
  const [target, setTarget] = useState(85);
  const [data, setData] = useState<CapacityPlan | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [narrative, setNarrative] = useState<NarrativeState>({ status: "idle", narrative: null });
  const nextSignal = useAbortable();

  const load = useCallback(
    async (narrate: boolean) => {
      const signal = nextSignal();
      setLoading(true);
      setError(null);
      if (narrate) setNarrative({ status: "loading", narrative: null });
      try {
        const r = await fetchOptimize<CapacityPlan>(`/api/optimize/capacity?weeks=${weeks}&target=${target}&narrate=${narrate ? 1 : 0}`, "plan", undefined, signal);
        setData(r.data);
        if (narrate || r.narrative.narrative) setNarrative(r.narrative);
      } catch (e) {
        if (isAbortError(e)) return;
        setError(e instanceof Error ? e.message : "Could not load the capacity plan.");
        if (narrate) setNarrative({ status: "idle", narrative: null });
      } finally {
        if (!signal.aborted) setLoading(false);
      }
    },
    [nextSignal, weeks, target]
  );
  useEffect(() => {
    void load(false);
  }, [load]);

  const future = data?.weeks.filter((w) => !w.past) ?? [];
  const avg = future.length ? future.reduce((s, w) => s + w.utilisation, 0) / future.length : 0;
  const sug = data?.suggestion;
  const sugTone = sug?.kind === "hire" ? "danger" : sug?.kind === "extra_hours" ? "warning" : sug?.kind === "underused" ? "info" : "success";

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Plan ahead">
          <Select value={String(weeks)} onChange={(e) => setWeeks(Number(e.target.value))} className="w-36">
            {[4, 8, 12, 26].map((w) => <option key={w} value={w}>{w} weeks</option>)}
          </Select>
        </Field>
        <Field label="Target utilisation">
          <Select value={String(target)} onChange={(e) => setTarget(Number(e.target.value))} className="w-28">
            {[70, 75, 80, 85, 90, 100].map((t) => <option key={t} value={t}>{t}%</option>)}
          </Select>
        </Field>
        <Button variant="outline" size="icon" touch onClick={() => void load(false)} disabled={loading} aria-label="Refresh plan">
          {loading ? spinner : <RefreshCw className="h-4 w-4" aria-hidden />}
        </Button>
      </div>
      {error && <Banner tone="error" onDismiss={() => setError(null)}>{error}</Banner>}
      {loading && !data ? (
        <Loading label="Planning capacity…" />
      ) : !data && error ? (
        <ErrorState message={error} onRetry={() => void load(false)} />
      ) : data && sug ? (
        <div aria-busy={loading || undefined} className="space-y-5">
          {sug.kind === "no_data" ? (
            <Empty icon={<Users className="h-5 w-5" />} title="No bookings or logged time yet" text="Confirmed bookings and time entries feed the plan. Availability comes from your calendar rules." />
          ) : (
            <>
              <section aria-label="Summary" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                <Stat label="People" value={String(data.people)} />
                <Stat label="Hours per person / week" value={hrs(data.weeklyMinutesPerPerson)} />
                <Stat label="Avg utilisation (ahead)" value={pct(avg)} tone={avg > data.target ? "bad" : undefined} />
                <Stat label="Bottleneck weeks" value={String(data.bottleneckWeeks.length)} tone={data.bottleneckWeeks.length ? "bad" : "good"} />
              </section>
              <section aria-label="Utilisation chart" className="rounded-xl border border-border bg-card p-3 sm:p-4">
                <UtilisationChart target={data.target} points={data.weeks.map((w) => ({ weekStart: w.weekStart, utilisation: w.utilisation, bottleneck: w.bottleneck, past: w.past }))} />
              </section>
              <section aria-labelledby="suggestion-heading" className="rounded-xl border border-border bg-card p-4 sm:p-5">
                <h2 id="suggestion-heading" className="flex items-center gap-2 text-sm font-semibold"><Lightbulb className="h-4 w-4 text-primary" aria-hidden /> Suggestion <Pill tone={sugTone}>{sug.kind.replace("_", " ")}</Pill></h2>
                <p className="mt-2 text-sm">{sug.message}</p>
                {(sug.hires > 0 || sug.extraHoursPerWeek > 0) && (
                  <p className="mt-1 text-sm text-muted-foreground">{sug.hires > 0 ? `${sug.hires} hire${sug.hires === 1 ? "" : "s"}` : `${sug.extraHoursPerWeek}h extra per week at peak`}</p>
                )}
              </section>
            </>
          )}
          <NarrativeCard state={narrative} onGenerate={() => void load(true)} busy={loading} />
          {sug.kind !== "no_data" && data.members.length > 0 && (
            <details className="rounded-xl border border-border bg-card">
              <summary className="cursor-pointer px-4 py-3 text-sm font-semibold">Per member (look-back)</summary>
              <div className="px-4 pb-4">
                <TableScroller label="Utilisation by member">
                  <table className="w-full min-w-[32rem] text-sm">
                    <thead className={THEAD}>
                      <tr>
                        <th scope="col" className={TH}>Member</th>
                        {data.weeks.filter((w) => w.past).map((w) => <th key={w.weekStart} scope="col" className={cn(TH, "text-right")}>{w.weekStart.slice(5)}</th>)}
                        <th scope="col" className={cn(TH, "text-right")}>Avg</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {data.members.map((m) => (
                        <tr key={m.id}>
                          <td className="px-3 py-1.5">{m.label}</td>
                          {m.weeks.filter((_, i) => data.weeks[i].past).map((w) => (
                            <td key={w.weekStart} className={cn("px-3 py-1.5 text-right tabular-nums", w.utilisation > data.target && "text-amber-700 dark:text-amber-300")}>{pct(w.utilisation)}</td>
                          ))}
                          <td className="px-3 py-1.5 text-right font-medium tabular-nums">{pct(m.avgUtilisation)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableScroller>
                <p className="mt-2 text-xs text-muted-foreground">Member utilisation uses logged time plus bookings assigned to them. Unassigned bookings count toward the team total only.</p>
              </div>
            </details>
          )}
        </div>
      ) : null}
    </div>
  );
}

// ── Pricing ──────────────────────────────────────────────────────────────────

interface Row { description: string; qty: string; price: string }
interface QuoteLite { id: string; number: string; status: string; currency: string; items: Array<{ description: string; qty: number; unit_minor: number }> }

function PricingTab() {
  const [rows, setRows] = useState<Row[]>([{ description: "", qty: "1", price: "" }]);
  const [quotes, setQuotes] = useState<QuoteLite[]>([]);
  const [currency, setCurrency] = useState("USD");
  const [data, setData] = useState<PricingSuggestion | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [narrative, setNarrative] = useState<NarrativeState>({ status: "idle", narrative: null });
  const nextSignal = useAbortable();

  useEffect(() => {
    let active = true;
    fetch("/api/quotes")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!active || !d) return;
        const list = Array.isArray(d.quotes) ? (d.quotes as QuoteLite[]) : [];
        setQuotes(list);
        if (list[0]?.currency) setCurrency(list[0].currency);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  function loadQuote(id: string) {
    const q = quotes.find((x) => x.id === id);
    if (!q) return;
    setCurrency(q.currency);
    setRows(q.items.map((i) => ({ description: i.description, qty: String(i.qty), price: (i.unit_minor / 100).toFixed(2) })));
    setData(null);
  }

  const items = rows.filter((r) => r.description.trim()).map((r) => ({ description: r.description.trim(), qty: Number(r.qty) || 1, unit_minor: Math.round((Number(r.price) || 0) * 100) }));

  const run = useCallback(
    async (narrate: boolean) => {
      if (items.length === 0) {
        setError("Add at least one line item.");
        return;
      }
      const signal = nextSignal();
      setLoading(true);
      setError(null);
      if (narrate) setNarrative({ status: "loading", narrative: null });
      try {
        const r = await fetchOptimize<PricingSuggestion>("/api/optimize/pricing", "suggestion", { method: "POST", body: JSON.stringify({ items, narrate }) }, signal);
        setData(r.data);
        if (narrate || r.narrative.narrative) setNarrative(r.narrative);
      } catch (e) {
        if (isAbortError(e)) return;
        setError(e instanceof Error ? e.message : "Could not compute the suggestion.");
        if (narrate) setNarrative({ status: "idle", narrative: null });
      } finally {
        if (!signal.aborted) setLoading(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [nextSignal, JSON.stringify(items)]
  );

  return (
    <div className="space-y-5">
      <section aria-labelledby="pricing-form-heading" className="rounded-xl border border-border bg-card p-4 sm:p-5">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h2 id="pricing-form-heading" className="text-sm font-semibold">Line items to price</h2>
          {quotes.length > 0 && (
            <Field label="Load from a quote">
              <Select defaultValue="" onChange={(e) => loadQuote(e.target.value)} className="w-56">
                <option value="">Choose a quote…</option>
                {quotes.map((q) => <option key={q.id} value={q.id}>{q.number} · {q.status} · {q.items.length} item{q.items.length === 1 ? "" : "s"}</option>)}
              </Select>
            </Field>
          )}
        </div>
        <form
          className="mt-3 space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            void run(false);
          }}
        >
          {rows.map((r, i) => {
            const lbl = i > 0 ? "[&>label]:sr-only" : "";
            return (
              <div key={i} className="grid grid-cols-2 items-end gap-2 sm:grid-cols-[1fr_5rem_8rem_2.75rem]">
                <Field label="Description" className={cn("col-span-2 sm:col-span-1", lbl)}>
                  <Input value={r.description} onChange={(e) => setRows((rs) => rs.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))} placeholder="Website design (5 pages)" maxLength={500} />
                </Field>
                <Field label="Qty" className={lbl}>
                  <Input type="number" inputMode="decimal" min={0} step="any" value={r.qty} onChange={(e) => setRows((rs) => rs.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)))} />
                </Field>
                <Field label={`Unit price (${currency})`} className={lbl}>
                  <Input type="number" inputMode="decimal" min={0} step="0.01" value={r.price} onChange={(e) => setRows((rs) => rs.map((x, j) => (j === i ? { ...x, price: e.target.value } : x)))} />
                </Field>
                <Button type="button" variant="ghost" size="icon" touch className="col-span-2 justify-self-end sm:col-span-1" disabled={rows.length === 1} onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))} aria-label={`Remove item ${i + 1}`}>
                  <Trash2 className="h-4 w-4" aria-hidden />
                </Button>
              </div>
            );
          })}
          <div className="flex flex-wrap gap-2 pt-1">
            <Button type="button" variant="outline" touch onClick={() => setRows((rs) => [...rs, { description: "", qty: "1", price: "" }])} disabled={rows.length >= 50}>
              <Plus className="h-4 w-4" aria-hidden /> Add item
            </Button>
            <Button type="submit" touch disabled={loading || items.length === 0}>
              {loading ? spinner : <TrendingUp className="h-4 w-4" aria-hidden />} Suggest pricing
            </Button>
          </div>
        </form>
      </section>

      {error && <Banner tone="error" onDismiss={() => setError(null)}>{error}</Banner>}

      {data && (
        <div aria-busy={loading || undefined} className="space-y-5">
          <section aria-label="Summary" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Decided quotes" value={String(data.overall.quotes)} />
            <Stat label="Won" value={String(data.overall.won)} />
            <Stat label="Lost / expired" value={String(data.overall.lost)} />
            <Stat label="Overall win rate" value={pct(data.overall.winRate)} />
          </section>
          {data.overall.quotes === 0 && (
            <Empty icon={<TrendingUp className="h-5 w-5" />} title="No decided quotes yet" text="Suggestions need accepted and declined quotes to learn from. Keep sending quotes; this fills in as clients respond." />
          )}
          {data.items.map((it, i) => (
            <section key={i} aria-labelledby={`item-${i}`} className="rounded-xl border border-border bg-card p-4 sm:p-5">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <h3 id={`item-${i}`} className="truncate text-sm font-semibold">{it.description}</h3>
                  <p className="text-xs text-muted-foreground">Now {fmtMoney(it.current_unit_minor, currency)} · win probability {pct(it.expectedWinProbability)} · {it.matches} matching line{it.matches === 1 ? "" : "s"}</p>
                </div>
                {it.basis === "history" ? <Pill tone="success">From history</Pill> : <Pill tone="neutral">Not enough history</Pill>}
              </div>
              {it.basis === "history" && it.suggested_min_minor !== null && it.suggested_max_minor !== null && it.suggested_unit_minor !== null ? (
                <>
                  <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
                    <Stat label="Suggested range" value={`${fmtMoney(it.suggested_min_minor, currency)} – ${fmtMoney(it.suggested_max_minor, currency)}`} />
                    <Stat label="Best price" value={fmtMoney(it.suggested_unit_minor, currency)} tone="good" />
                    <Stat label="Win probability there" value={pct(it.suggestedWinProbability ?? 0)} />
                  </div>
                  <p className="mt-3 text-sm">{it.note} {it.expectedValueDelta_minor !== 0 && <span className="text-muted-foreground">Expected value per line changes by {it.expectedValueDelta_minor > 0 ? "+" : ""}{fmtMoney(it.expectedValueDelta_minor, currency)}.</span>}</p>
                  <div className="mt-3"><BandChart bands={it.bands} current={it.current_unit_minor} suggested={it.suggested_unit_minor} currency={currency} /></div>
                </>
              ) : (
                <p className="mt-3 text-sm text-muted-foreground">{it.note}</p>
              )}
            </section>
          ))}
          <NarrativeCard state={narrative} onGenerate={() => void run(true)} busy={loading} />
        </div>
      )}
    </div>
  );
}
