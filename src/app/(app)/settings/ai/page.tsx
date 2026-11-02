"use client";

import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { Gauge, Loader2, RefreshCw, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Banner, Empty, ErrorState, Loading } from "@/components/ui/feedback";
import { Field } from "@/components/ui/field";
import { Checkbox, Input } from "@/components/ui/input";
import { Pill } from "@/components/ui/pill";
import { TableScroller, TH, THEAD } from "@/components/ui/table-scroller";
import { isAbortError, useAbortable } from "@/components/ui/hooks";
import { PageContainer } from "@/components/page-container";
import { CreditsSection } from "@/components/credits/credits-section";
import { cn } from "@/lib/utils";

interface Totals { calls: number; promptTokens: number; completionTokens: number; costMicros: number }
interface FeatureRow extends Totals { feature: string }
interface ProviderRow extends Totals { provider: string; model: string }
interface SeriesPoint { date: string; calls: number; costMicros: number }
interface Budget { capMicros: number | null; hardStop: boolean; allowlist: string[] | null; spentMicros: number }
interface ProviderInfo {
  id: string; label: string; model: string; envKey: string; configured: boolean; supportsTools: boolean;
}
interface Usage {
  since: string;
  totals: Totals;
  byFeature: FeatureRow[];
  byProvider: ProviderRow[];
  series: SeriesPoint[];
  budget: Budget;
  providers: ProviderInfo[];
}

type Notice = { tone: "success" | "error"; text: string };

const fmtInt = (n: number) => new Intl.NumberFormat().format(Math.round(n || 0));
const fmtUsd = (micros: number) =>
  new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 4 }).format((micros || 0) / 1e6);
const fmtDay = (iso: string) => {
  const d = new Date(iso + "T00:00:00Z");
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, { day: "numeric", month: "short", timeZone: "UTC" });
};

async function readError(res: Response, fallback: string): Promise<string> {
  const d = await res.json().catch(() => null);
  return typeof d?.error === "string" ? d.error : `${fallback} (${res.status})`;
}

export default function AiSettingsPage() {
  const [usage, setUsage] = useState<Usage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const nextSignal = useAbortable();

  // Budget editor state
  const [capUsd, setCapUsd] = useState("");
  const [capError, setCapError] = useState<string | null>(null);
  const [hardStop, setHardStop] = useState(true);
  const [allowAll, setAllowAll] = useState(true);
  const [allow, setAllow] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const signal = nextSignal();
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/ai/usage", { cache: "no-store", signal });
      if (!res.ok) throw new Error(await readError(res, "Could not load AI usage"));
      const data: Usage = await res.json();
      setUsage(data);
      setCapUsd(data.budget.capMicros == null ? "" : String(data.budget.capMicros / 1e6));
      setHardStop(data.budget.hardStop);
      setAllowAll(data.budget.allowlist == null);
      setAllow(new Set(data.budget.allowlist ?? []));
    } catch (err) {
      if (isAbortError(err)) return;
      setError(err instanceof Error ? err.message : "Could not load AI usage.");
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }, [nextSignal]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const cap = capUsd.trim() === "" ? null : Number(capUsd);
    if (cap !== null && (!Number.isFinite(cap) || cap < 0 || cap > 10_000)) {
      setCapError("Enter an amount between 0 and 10,000 USD, or leave blank for no cap.");
      return;
    }
    setCapError(null);
    setSaving(true);
    setNotice(null);
    try {
      const res = await fetch("/api/ai/budget", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ capUsd: cap, hardStop, allowlist: allowAll ? null : Array.from(allow) }),
      });
      if (!res.ok) throw new Error(await readError(res, "Could not save the AI budget"));
      setNotice({ tone: "success", text: "AI budget saved." });
      await load();
    } catch (err) {
      setNotice({ tone: "error", text: err instanceof Error ? err.message : "Could not save the AI budget." });
    } finally {
      setSaving(false);
    }
  }

  function toggleProvider(id: string) {
    setAllow((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const noneConfigured = usage ? !usage.providers.some((p) => p.configured) : false;
  const capMicros = usage?.budget.capMicros ?? null;
  const spent = usage?.totals.costMicros ?? 0;
  const pct = capMicros ? Math.min(100, (spent / capMicros) * 100) : 0;
  const allowlistInvalid = !allowAll && allow.size === 0;

  return (
    <PageContainer
      wide
      title="AI settings"
      description="Monthly AI spend, caps and which model providers your agents may use."
      tooltip="Every model call is metered. Set a cap to stop runaway agents before the invoice does."
      actions={
        <Button variant="outline" touch onClick={() => void load()} disabled={loading} aria-label="Refresh usage">
          {loading ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden /> : <RefreshCw className="h-4 w-4" aria-hidden />}
          Refresh
        </Button>
      }
    >
      {notice && (
        <Banner tone={notice.tone} onDismiss={() => setNotice(null)}>
          {notice.text}
        </Banner>
      )}
      {noneConfigured && (
        <Banner tone="warn">
          No model provider is configured. Set <code className="font-mono">GROQ_API_KEY</code> or <code className="font-mono">GEMINI_API_KEY</code> in the deployment environment to enable AI features.
        </Banner>
      )}

      <p className="mb-6 flex items-center gap-2 text-sm text-muted-foreground" role="status" aria-live="polite">
        <Gauge className="h-4 w-4" aria-hidden />
        {usage ? `Usage since ${new Date(usage.since).toLocaleDateString(undefined, { dateStyle: "medium" })}` : "Usage this month"}
      </p>

      <CreditsSection />

      <div aria-busy={loading || undefined}>
        {loading && !usage ? (
          <Loading label="Loading AI usage…" className="rounded-xl border border-border bg-card" />
        ) : error && !usage ? (
          <ErrorState message={error} onRetry={() => void load()} />
        ) : usage ? (
          <>
            {error && (
              <Banner tone="error" onDismiss={() => setError(null)}>
                {error}
              </Banner>
            )}
            <section className="mb-6 grid gap-4 sm:grid-cols-3" aria-label="This month's spend">
              <StatCard label="Spend this month" value={fmtUsd(usage.totals.costMicros)} hint={capMicros != null ? `${pct.toFixed(0)}% of ${fmtUsd(capMicros)} cap` : "No cap set"} />
              <StatCard label="Model calls" value={fmtInt(usage.totals.calls)} />
              <StatCard label="Tokens" value={fmtInt(usage.totals.promptTokens + usage.totals.completionTokens)} hint={`${fmtInt(usage.totals.promptTokens)} in · ${fmtInt(usage.totals.completionTokens)} out`} />
            </section>

            {capMicros != null && (
              <div className="mb-6">
                <div
                  className="h-2 w-full overflow-hidden rounded-full bg-secondary"
                  role="progressbar"
                  aria-valuenow={Math.round(pct)}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-label={`Monthly cap used: ${pct.toFixed(0)}%`}
                >
                  <div className={cn("h-full rounded-full", pct >= 100 ? "bg-destructive" : pct >= 80 ? "bg-amber-500" : "bg-primary")} style={{ width: `${pct}%` }} />
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {fmtUsd(spent)} of {fmtUsd(capMicros)} used{usage.budget.hardStop ? " · calls stop at the cap" : " · warn only"}
                </p>
              </div>
            )}

            <section className="mb-6 rounded-xl border border-border bg-card p-4 sm:p-5" aria-labelledby="spend-chart-heading">
              <h2 id="spend-chart-heading" className="mb-1 text-sm font-semibold">
                Daily spend, last 30 days
              </h2>
              <p className="mb-4 text-xs text-muted-foreground">
                {fmtDay(usage.series[0]?.date ?? "")} to {fmtDay(usage.series[usage.series.length - 1]?.date ?? "")}
              </p>
              {usage.series.every((p) => p.costMicros === 0 && p.calls === 0) ? (
                <Empty title="No model calls in the last 30 days" text="Spend appears here as soon as an agent or the copilot makes a model call." className="py-8" />
              ) : (
                <SpendChart points={usage.series} />
              )}
            </section>

            <form onSubmit={(e) => void save(e)} className="mb-6 rounded-xl border border-border bg-card p-4 sm:p-5" aria-labelledby="cap-heading">
              <h2 id="cap-heading" className="mb-1 text-sm font-semibold">
                Monthly cap
              </h2>
              <p className="mb-4 text-sm text-muted-foreground">When hard stop is on, model calls are refused once spend reaches the cap. Leave blank for no cap.</p>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Cap (USD per month)" error={capError} hint="Between 0 and 10,000.">
                  <Input
                    type="number"
                    inputMode="decimal"
                    min={0}
                    max={10000}
                    step="0.01"
                    value={capUsd}
                    onChange={(e) => {
                      setCapUsd(e.target.value);
                      setCapError(null);
                    }}
                    placeholder="No cap"
                  />
                </Field>
                <div className="sm:pt-5">
                  <Checkbox
                    checked={hardStop}
                    onChange={(e) => setHardStop(e.target.checked)}
                    label={
                      <span>
                        <span className="font-medium">Hard stop at cap</span>
                        <span className="block text-xs text-muted-foreground">Off means warn only; calls continue.</span>
                      </span>
                    }
                  />
                </div>
              </div>

              <fieldset className="mt-6">
                <legend className="mb-2 text-sm font-semibold">Model allowlist</legend>
                <Checkbox checked={allowAll} onChange={(e) => setAllowAll(e.target.checked)} label="Allow every configured provider" />
                <ul className={cn("mt-2 space-y-1", allowAll && "opacity-60")}>
                  {usage.providers.map((p) => (
                    <li key={p.id}>
                      <Checkbox
                        disabled={allowAll}
                        checked={allowAll || allow.has(p.id)}
                        onChange={() => toggleProvider(p.id)}
                        label={
                          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                            <span className="font-medium">{p.label}</span>
                            <code className="text-xs text-muted-foreground">{p.model}</code>
                            <Pill tone={p.configured ? "success" : "warning"}>{p.configured ? "configured" : `set ${p.envKey}`}</Pill>
                            {p.supportsTools && <Pill tone="neutral">tools</Pill>}
                          </span>
                        }
                      />
                    </li>
                  ))}
                </ul>
                {allowlistInvalid && (
                  <p role="alert" className="mt-2 text-xs text-destructive">
                    Select at least one provider, or allow all.
                  </p>
                )}
              </fieldset>

              <div className="mt-5">
                <Button type="submit" touch disabled={saving || allowlistInvalid}>
                  {saving ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden /> : <Save className="h-4 w-4" aria-hidden />}
                  Save budget
                </Button>
              </div>
            </form>

            <section className="mb-6 rounded-xl border border-border bg-card p-4 sm:p-5" aria-labelledby="feature-heading">
              <h2 id="feature-heading" className="mb-3 text-sm font-semibold">
                Spend by feature
              </h2>
              {usage.byFeature.length === 0 ? (
                <Empty title="No usage yet this month" text="Each feature that calls a model shows up here with its calls, tokens and cost." className="py-8" />
              ) : (
                <TableScroller label="Spend by feature">
                  <table className="w-full min-w-[560px] text-sm">
                    <thead className={THEAD}>
                      <tr>
                        <th scope="col" className={TH}>Feature</th>
                        <th scope="col" className={cn(TH, "text-right")}>Calls</th>
                        <th scope="col" className={cn(TH, "text-right")}>Tokens in</th>
                        <th scope="col" className={cn(TH, "text-right")}>Tokens out</th>
                        <th scope="col" className={cn(TH, "text-right")}>Cost</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {usage.byFeature.map((r) => (
                        <tr key={r.feature}>
                          <th scope="row" className="px-3 py-2 text-left font-medium capitalize">{r.feature}</th>
                          <td className="px-3 py-2 text-right tabular-nums">{fmtInt(r.calls)}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{fmtInt(r.promptTokens)}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{fmtInt(r.completionTokens)}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{fmtUsd(r.costMicros)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableScroller>
              )}
            </section>

            {usage.byProvider.length > 0 && (
              <section className="rounded-xl border border-border bg-card p-4 sm:p-5" aria-labelledby="provider-heading">
                <h2 id="provider-heading" className="mb-3 text-sm font-semibold">
                  Spend by provider
                </h2>
                <ul className="divide-y divide-border">
                  {usage.byProvider.map((r) => (
                    <li key={`${r.provider}:${r.model}`} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-2.5 text-sm">
                      <span className="min-w-0">
                        <span className="font-medium capitalize">{r.provider}</span>
                        <code className="ml-2 text-xs text-muted-foreground">{r.model}</code>
                      </span>
                      <span className="shrink-0 tabular-nums text-muted-foreground">
                        {fmtInt(r.calls)} calls · {fmtUsd(r.costMicros)}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        ) : null}
      </div>
    </PageContainer>
  );
}

function StatCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-border bg-card p-4 sm:p-5">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
      {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

/* Single-series daily bar chart: one axis, recessive grid, hover/focus detail, text summary for AT. */
function SpendChart({ points }: { points: SeriesPoint[] }) {
  const id = useId();
  const [active, setActive] = useState<number | null>(null);
  const W = 720;
  const H = 180;
  const padL = 48;
  const padR = 8;
  const padT = 12;
  const padB = 24;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const { max, total, peak } = useMemo(() => {
    const m = Math.max(1, ...points.map((p) => p.costMicros));
    const p = Math.pow(10, Math.floor(Math.log10(m)));
    const n = m / p;
    const niceMax = (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
    const t = points.reduce((s, x) => s + x.costMicros, 0);
    const pk = points.reduce((a, b) => (b.costMicros > a.costMicros ? b : a), points[0]);
    return { max: niceMax, total: t, peak: pk };
  }, [points]);

  const step = plotW / Math.max(1, points.length);
  const barW = Math.max(2, step - 2);
  const ticks = [0, 0.5, 1];
  const summary = `Daily AI spend for ${points.length} days, ${fmtUsd(total)} in total; peak ${fmtUsd(peak.costMicros)} on ${fmtDay(peak.date)}.`;
  const cur = active === null ? null : points[active];

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-labelledby={`${id}-title`} onMouseLeave={() => setActive(null)}>
        <title id={`${id}-title`}>{summary}</title>
        {ticks.map((t) => {
          const y = padT + plotH - t * plotH;
          return (
            <g key={t}>
              <line x1={padL} x2={W - padR} y1={y} y2={y} stroke="hsl(var(--border))" strokeWidth={1} />
              <text x={padL - 6} y={y + 4} textAnchor="end" fontSize={11} fill="hsl(var(--muted-foreground))">
                {t === 0 ? "$0" : fmtUsd(max * t)}
              </text>
            </g>
          );
        })}
        {points.map((p, i) => {
          const h = (p.costMicros / max) * plotH;
          const x = padL + i * step + (step - barW) / 2;
          const y = padT + plotH - h;
          const isActive = active === i;
          return (
            <g key={p.date}>
              <rect
                x={padL + i * step}
                y={padT}
                width={step}
                height={plotH}
                fill="transparent"
                tabIndex={0}
                aria-label={`${fmtDay(p.date)}: ${fmtUsd(p.costMicros)}, ${fmtInt(p.calls)} calls`}
                onMouseEnter={() => setActive(i)}
                onFocus={() => setActive(i)}
                onBlur={() => setActive(null)}
                className="outline-none focus-visible:stroke-[hsl(var(--ring))] focus-visible:[stroke-width:2]"
              />
              <rect x={x} y={y} width={barW} height={Math.max(h, p.costMicros > 0 ? 2 : 0)} rx={2} fill="hsl(var(--primary))" opacity={isActive || active === null ? 1 : 0.45} pointerEvents="none" />
            </g>
          );
        })}
        {points.map((p, i) =>
          i % 7 === 0 || i === points.length - 1 ? (
            <text key={`x-${p.date}`} x={padL + i * step + step / 2} y={H - 6} textAnchor="middle" fontSize={11} fill="hsl(var(--muted-foreground))">
              {fmtDay(p.date)}
            </text>
          ) : null
        )}
      </svg>
      <p role="status" aria-live="polite" className="mt-2 min-h-5 text-xs text-muted-foreground">
        {cur ? (
          <>
            <span className="font-medium text-foreground">{fmtDay(cur.date)}</span> · {fmtUsd(cur.costMicros)} · {fmtInt(cur.calls)} calls
          </>
        ) : (
          "Hover or tab across the bars for daily detail."
        )}
      </p>
    </div>
  );
}
