"use client";

import { useEffect, useState } from "react";
import { Loader2, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Banner } from "@/components/ui/feedback";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { TableScroller, TH, THEAD } from "@/components/ui/table-scroller";

export interface LimitsBudget {
  dailyCapMicros: number | null;
  featureCaps: Record<string, number>;
  spentByFeature: Record<string, number>;
  spentTodayMicros: number;
  maxTokensPerCall: number | null;
  fallbackModel: string | null;
}
export interface TopRun { runId: string; feature: string; calls: number; costMicros: number; tokens: number; lastAt: string | null }

const FEATURES = ["agent", "copilot", "chat", "playbook", "receptionist", "generate", "other"];
const usd = (micros: number) => `$${(micros / 1e6).toFixed(2)}`;

/** "Limits" section: daily cap, per-feature monthly caps, max tokens per call, cheap fallback model, top runs. */
export function AiLimits({ budget, topRuns, onSaved }: { budget: LimitsBudget; topRuns: TopRun[]; onSaved?: () => void }) {
  const [daily, setDaily] = useState("");
  const [caps, setCaps] = useState<Record<string, string>>({});
  const [maxTokens, setMaxTokens] = useState("");
  const [fallback, setFallback] = useState("");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  useEffect(() => {
    setDaily(budget.dailyCapMicros == null ? "" : String(budget.dailyCapMicros / 1e6));
    setCaps(Object.fromEntries(Object.entries(budget.featureCaps).map(([k, v]) => [k, String(v / 1e6)])));
    setMaxTokens(budget.maxTokensPerCall == null ? "" : String(budget.maxTokensPerCall));
    setFallback(budget.fallbackModel ?? "");
  }, [budget]);

  const invalid = (v: string) => v.trim() !== "" && !(Number(v) >= 0);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (invalid(daily) || Object.values(caps).some(invalid)) return;
    setSaving(true);
    setMsg(null);
    try {
      const featureCapsUsd = Object.fromEntries(Object.entries(caps).filter(([, v]) => v.trim() !== "").map(([k, v]) => [k, Number(v)]));
      const res = await fetch("/api/ai/budget", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dailyCapUsd: daily.trim() === "" ? null : Number(daily),
          featureCapsUsd,
          maxTokensPerCall: maxTokens.trim() === "" ? null : Math.round(Number(maxTokens)),
          fallbackModel: fallback.trim() === "" ? null : fallback.trim(),
        }),
      });
      if (!res.ok) throw new Error("Could not save the limits.");
      setMsg({ tone: "success", text: "Limits saved." });
      onSaved?.();
    } catch (err) {
      setMsg({ tone: "error", text: err instanceof Error ? err.message : "Could not save the limits." });
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="mb-6 rounded-xl border border-border bg-card p-4 sm:p-5" aria-labelledby="limits-heading">
      <h2 id="limits-heading" className="mb-1 text-sm font-semibold">Limits</h2>
      <p className="mb-4 text-xs text-muted-foreground">
        Cap spend per day and per feature, bound each call, and route low-risk work (titles, summaries) to a cheaper model. Spent today: {usd(budget.spentTodayMicros)}.
      </p>
      {msg && <Banner tone={msg.tone}>{msg.text}</Banner>}
      <form onSubmit={save} noValidate>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Daily cap (USD)" hint="Blank = no daily cap" error={invalid(daily) ? "Enter a number" : null}>
            <Input inputMode="decimal" value={daily} onChange={(e) => setDaily(e.target.value)} />
          </Field>
          <Field label="Max tokens per call" hint="Blank = default">
            <Input inputMode="numeric" value={maxTokens} onChange={(e) => setMaxTokens(e.target.value)} />
          </Field>
          <Field label="Fallback model" hint="Used when a feature asks for the fast tier">
            <Input value={fallback} maxLength={80} onChange={(e) => setFallback(e.target.value)} />
          </Field>
        </div>
        <div className="mt-4">
          <TableScroller label="Per-feature monthly caps">
            <table className="w-full text-sm">
              <thead className={THEAD}>
                <tr><th className={TH}>Feature</th><th className={TH}>Spent this month</th><th className={TH}>Monthly cap (USD)</th></tr>
              </thead>
              <tbody>
                {FEATURES.map((f) => (
                  <tr key={f} className="border-t border-border">
                    <td className="px-3 py-2 capitalize">{f}</td>
                    <td className="px-3 py-2 tabular-nums">{usd(budget.spentByFeature[f] ?? 0)}</td>
                    <td className="px-3 py-2">
                      <Input aria-label={`${f} monthly cap in USD`} inputMode="decimal" className="max-w-[8rem]" placeholder="No cap" value={caps[f] ?? ""} onChange={(e) => setCaps({ ...caps, [f]: e.target.value })} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroller>
        </div>
        <div className="mt-5">
          <Button type="submit" touch disabled={saving}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden /> : <Save className="h-4 w-4" aria-hidden />}
            Save limits
          </Button>
        </div>
      </form>

      <h3 className="mb-2 mt-6 text-sm font-semibold">Most expensive runs this month</h3>
      {topRuns.length === 0 ? (
        <p className="text-xs text-muted-foreground">No run-level usage yet.</p>
      ) : (
        <TableScroller label="Top 5 expensive runs">
          <table className="w-full text-sm">
            <thead className={THEAD}>
              <tr><th className={TH}>Run</th><th className={TH}>Feature</th><th className={TH}>Calls</th><th className={TH}>Tokens</th><th className={TH}>Cost</th></tr>
            </thead>
            <tbody>
              {topRuns.map((r) => (
                <tr key={r.runId} className="border-t border-border">
                  <td className="px-3 py-2 font-mono text-xs">{r.runId.slice(0, 8)}</td>
                  <td className="px-3 py-2 capitalize">{r.feature}</td>
                  <td className="px-3 py-2 tabular-nums">{r.calls}</td>
                  <td className="px-3 py-2 tabular-nums">{r.tokens.toLocaleString()}</td>
                  <td className="px-3 py-2 tabular-nums">{usd(r.costMicros)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroller>
      )}
    </section>
  );
}
