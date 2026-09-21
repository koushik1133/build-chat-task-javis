"use client";

import { useState, useEffect, useCallback } from "react";
import { Gauge, Loader2, AlertTriangle, RefreshCw, X, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageContainer } from "@/components/page-container";
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

const fmtInt = (n: number) => new Intl.NumberFormat().format(Math.round(n || 0));
const fmtUsd = (micros: number) =>
  new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 4 })
    .format((micros || 0) / 1e6);

export default function AiSettingsPage() {
  const [usage, setUsage] = useState<Usage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Budget editor state
  const [capUsd, setCapUsd] = useState<string>("");
  const [hardStop, setHardStop] = useState(true);
  const [allowAll, setAllowAll] = useState(true);
  const [allow, setAllow] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/ai/usage");
      if (!res.ok) throw new Error("Could not load AI usage.");
      const data: Usage = await res.json();
      setUsage(data);
      setCapUsd(data.budget.capMicros == null ? "" : String(data.budget.capMicros / 1e6));
      setHardStop(data.budget.hardStop);
      setAllowAll(data.budget.allowlist == null);
      setAllow(new Set(data.budget.allowlist ?? []));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load AI usage.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function save() {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const cap = capUsd.trim() === "" ? null : Number(capUsd);
      if (cap !== null && (!Number.isFinite(cap) || cap < 0 || cap > 10_000)) {
        throw new Error("Monthly cap must be between 0 and 10,000 USD.");
      }
      const res = await fetch("/api/ai/budget", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          capUsd: cap,
          hardStop,
          allowlist: allowAll ? null : Array.from(allow),
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? "Could not save AI budget.");
      setNotice("AI budget saved.");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save AI budget.");
    } finally {
      setSaving(false);
    }
  }

  function toggleProvider(id: string) {
    setAllow((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  const noneConfigured = usage ? !usage.providers.some((p) => p.configured) : false;
  const maxCost = Math.max(1, ...(usage?.series ?? []).map((p) => p.costMicros));
  const capMicros = usage?.budget.capMicros ?? null;
  const spent = usage?.totals.costMicros ?? 0;
  const pct = capMicros ? Math.min(100, (spent / capMicros) * 100) : 0;

  return (
    <PageContainer
      wide
      title="AI Settings"
      description="Monthly AI spend, caps and which model providers your agents may use."
      tooltip="Every model call is metered. Set a cap to stop runaway agents before the invoice does."
    >
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Gauge className="h-4 w-4" aria-hidden />
          {usage ? `Usage since ${new Date(usage.since).toLocaleDateString()}` : "Usage this month"}
        </div>
        <Button variant="outline" onClick={() => void load()} disabled={loading} aria-label="Refresh usage">
          {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden /> : <RefreshCw className="mr-2 h-4 w-4" aria-hidden />}
          Refresh
        </Button>
      </div>

      {error && <Banner tone="error" onDismiss={() => setError(null)}>{error}</Banner>}
      {notice && <Banner tone="info" onDismiss={() => setNotice(null)}>{notice}</Banner>}

      {noneConfigured && (
        <Banner tone="warn">
          No model provider is configured. Set <code className="font-mono">GROQ_API_KEY</code> or{" "}
          <code className="font-mono">GEMINI_API_KEY</code> in the deployment environment to enable AI features.
        </Banner>
      )}

      {loading && !usage && (
        <div className="flex items-center justify-center py-16 text-muted-foreground" role="status" aria-live="polite">
          <Loader2 className="mr-2 h-5 w-5 animate-spin" aria-hidden /> Loading AI usage…
        </div>
      )}

      {usage && (
        <>
          <section className="mb-6 grid gap-4 sm:grid-cols-3" aria-label="This month's spend">
            <StatCard label="Spend this month" value={fmtUsd(usage.totals.costMicros)}
              hint={capMicros != null ? `${pct.toFixed(0)}% of ${fmtUsd(capMicros)} cap` : "No cap set"} />
            <StatCard label="Model calls" value={fmtInt(usage.totals.calls)} />
            <StatCard
              label="Tokens"
              value={fmtInt(usage.totals.promptTokens + usage.totals.completionTokens)}
              hint={`${fmtInt(usage.totals.promptTokens)} in · ${fmtInt(usage.totals.completionTokens)} out`}
            />
          </section>

          {capMicros != null && (
            <div className="mb-6 h-2 w-full overflow-hidden rounded-full bg-muted" role="progressbar"
              aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100} aria-label="Cap used">
              <div className={cn("h-full rounded-full", pct >= 100 ? "bg-red-500" : pct >= 80 ? "bg-amber-500" : "bg-foreground/80")}
                style={{ width: `${pct}%` }} />
            </div>
          )}

          <section className="mb-6 rounded-xl border border-border bg-card p-5">
            <h2 className="mb-4 font-semibold">Last 30 days</h2>
            {usage.series.every((p) => p.costMicros === 0 && p.calls === 0) ? (
              <p className="text-sm text-muted-foreground">No model calls recorded in the last 30 days.</p>
            ) : (
              <div className="flex h-32 items-end gap-1 overflow-x-auto" aria-label="Daily AI spend">
                {usage.series.map((p) => (
                  <div key={p.date} className="group relative flex min-w-[6px] flex-1 flex-col justify-end"
                    title={`${p.date} — ${fmtUsd(p.costMicros)}, ${fmtInt(p.calls)} calls`}>
                    <div className="rounded-t bg-foreground/80 transition-colors group-hover:bg-foreground"
                      style={{ height: `${Math.max(2, (p.costMicros / maxCost) * 100)}%` }} />
                  </div>
                ))}
              </div>
            )}
            <p className="mt-2 text-xs text-muted-foreground">
              {usage.series[0]?.date} → {usage.series[usage.series.length - 1]?.date}
            </p>
          </section>

          <section className="mb-6 rounded-xl border border-border bg-card p-5">
            <h2 className="mb-1 font-semibold">Monthly cap</h2>
            <p className="mb-4 text-sm text-muted-foreground">
              When hard stop is on, model calls are refused once spend reaches the cap. Leave blank for no cap.
            </p>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="block text-sm">
                <span className="mb-1 block font-medium">Cap (USD per month)</span>
                <input type="number" inputMode="decimal" min={0} max={10000} step="0.01" value={capUsd}
                  onChange={(e) => setCapUsd(e.target.value)} placeholder="No cap"
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm" />
              </label>
              <label className="flex items-center gap-3 pt-6 text-sm">
                <input type="checkbox" checked={hardStop} onChange={(e) => setHardStop(e.target.checked)}
                  className="h-4 w-4" />
                <span>
                  <span className="font-medium">Hard stop at cap</span>
                  <span className="block text-xs text-muted-foreground">Off = warn only, calls continue.</span>
                </span>
              </label>
            </div>

            <h3 className="mb-2 mt-6 text-sm font-semibold">Model allowlist</h3>
            <label className="mb-2 flex items-center gap-3 text-sm">
              <input type="checkbox" checked={allowAll} onChange={(e) => setAllowAll(e.target.checked)} className="h-4 w-4" />
              Allow every configured provider
            </label>
            <ul className={cn("space-y-2", allowAll && "opacity-50")}>
              {usage.providers.map((p) => (
                <li key={p.id} className="flex items-start gap-3 text-sm">
                  <input type="checkbox" id={`allow-${p.id}`} disabled={allowAll} checked={allowAll || allow.has(p.id)}
                    onChange={() => toggleProvider(p.id)} className="mt-0.5 h-4 w-4" />
                  <label htmlFor={`allow-${p.id}`} className="min-w-0">
                    <span className="font-medium">{p.label}</span>
                    <span className="ml-2 font-mono text-xs text-muted-foreground">{p.model}</span>
                    <span className={cn("ml-2 rounded-full px-2 py-0.5 text-xs",
                      p.configured ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400"
                        : "bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-400")}>
                      {p.configured ? "configured" : `set ${p.envKey}`}
                    </span>
                    {p.supportsTools && <span className="ml-2 text-xs text-muted-foreground">tools</span>}
                  </label>
                </li>
              ))}
            </ul>

            <div className="mt-5">
              <Button onClick={() => void save()} disabled={saving || (!allowAll && allow.size === 0)} aria-label="Save AI budget">
                {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden /> : <Save className="mr-2 h-4 w-4" aria-hidden />}
                Save
              </Button>
              {!allowAll && allow.size === 0 && (
                <p className="mt-2 text-xs text-red-600 dark:text-red-400">Select at least one provider or allow all.</p>
              )}
            </div>
          </section>

          <section className="mb-6 rounded-xl border border-border bg-card">
            <h2 className="border-b border-border px-5 py-4 font-semibold">Spend by feature</h2>
            {usage.byFeature.length === 0 ? (
              <p className="px-5 py-6 text-sm text-muted-foreground">No usage yet this month.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-left text-xs text-muted-foreground">
                    <tr>
                      <th className="px-5 py-2 font-medium">Feature</th>
                      <th className="px-5 py-2 text-right font-medium">Calls</th>
                      <th className="px-5 py-2 text-right font-medium">Tokens in</th>
                      <th className="px-5 py-2 text-right font-medium">Tokens out</th>
                      <th className="px-5 py-2 text-right font-medium">Cost</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {usage.byFeature.map((r) => (
                      <tr key={r.feature}>
                        <td className="px-5 py-2 font-medium capitalize">{r.feature}</td>
                        <td className="px-5 py-2 text-right tabular-nums">{fmtInt(r.calls)}</td>
                        <td className="px-5 py-2 text-right tabular-nums">{fmtInt(r.promptTokens)}</td>
                        <td className="px-5 py-2 text-right tabular-nums">{fmtInt(r.completionTokens)}</td>
                        <td className="px-5 py-2 text-right tabular-nums">{fmtUsd(r.costMicros)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {usage.byProvider.length > 0 && (
            <section className="rounded-xl border border-border bg-card">
              <h2 className="border-b border-border px-5 py-4 font-semibold">Spend by provider</h2>
              <ul className="divide-y divide-border">
                {usage.byProvider.map((r) => (
                  <li key={`${r.provider}:${r.model}`} className="flex items-center justify-between gap-3 px-5 py-3 text-sm">
                    <span className="min-w-0">
                      <span className="font-medium capitalize">{r.provider}</span>
                      <span className="ml-2 font-mono text-xs text-muted-foreground">{r.model}</span>
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
      )}
    </PageContainer>
  );
}

function StatCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
      {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function Banner({
  tone, children, onDismiss,
}: { tone: "error" | "info" | "warn"; children: React.ReactNode; onDismiss?: () => void }) {
  const styles = {
    error: "border-red-200 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-300",
    info: "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300",
    warn: "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300",
  }[tone];
  return (
    <div role={tone === "error" ? "alert" : "status"} className={cn("mb-4 flex items-start gap-2 rounded-lg border px-4 py-3 text-sm", styles)}>
      {tone !== "info" && <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />}
      <div className="min-w-0 flex-1">{children}</div>
      {onDismiss && (
        <button onClick={onDismiss} aria-label="Dismiss" className="shrink-0 opacity-70 hover:opacity-100">
          <X className="h-4 w-4" aria-hidden />
        </button>
      )}
    </div>
  );
}
