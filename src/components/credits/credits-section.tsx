"use client";

import { useCallback, useEffect, useState } from "react";
import { Coins, Loader2, RefreshCw, ShoppingCart } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Banner, Empty, ErrorState, Loading } from "@/components/ui/feedback";
import { Checkbox } from "@/components/ui/input";
import { Pill, type Tone } from "@/components/ui/pill";
import { TableScroller, TH, THEAD } from "@/components/ui/table-scroller";
import { formatCredits, formatCreditsAsMoney } from "@/lib/credits/pricing";
import type { CreditPack } from "@/lib/credits/packs";
import type { LedgerEntry } from "@/lib/credits/ledger";
import type { PurchaseDTO } from "@/lib/credits/checkout";
import { fmtMoney } from "@/lib/money/format";
import { cn } from "@/lib/utils";

interface CreditsView {
  balance: number;
  ledger: LedgerEntry[];
  purchases: PurchaseDTO[];
  packs: CreditPack[];
  creditsEnforced: boolean;
  markup: number;
  provider: string;
}

const KIND_TONE: Record<string, Tone> = {
  purchase: "success",
  grant: "info",
  refund: "success",
  adjustment: "neutral",
  usage: "neutral",
  outcome: "violet",
};

const fmtDate = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
};

/**
 * Credits block for Settings → AI: balance, enforcement toggle, packs to buy
 * and the ledger. Self-contained so the page only needs to mount it.
 */
export function CreditsSection() {
  const [view, setView] = useState<CreditsView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [buying, setBuying] = useState<string | null>(null);
  const [togglingEnforce, setTogglingEnforce] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/ai/credits", { cache: "no-store" });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? "Could not load AI credits.");
      setView(data as CreditsView);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load AI credits.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function buy(pack: CreditPack) {
    setBuying(pack.id);
    setError(null);
    try {
      const res = await fetch("/api/ai/credits/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ packId: pack.id }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.url) throw new Error(data?.error ?? "Could not start checkout.");
      window.location.assign(data.url as string);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start checkout.");
      setBuying(null);
    }
  }

  async function toggleEnforce(next: boolean) {
    if (!view) return;
    setTogglingEnforce(true);
    setError(null);
    setNotice(null);
    const prev = view.creditsEnforced;
    setView({ ...view, creditsEnforced: next });
    try {
      const res = await fetch("/api/ai/credits", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ creditsEnforced: next }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? "Could not save credit enforcement.");
      setNotice(next ? "Credits are now enforced: model calls stop when the balance hits zero." : "Credit enforcement is off: usage is tracked but never blocked.");
    } catch (err) {
      setView((v) => (v ? { ...v, creditsEnforced: prev } : v));
      setError(err instanceof Error ? err.message : "Could not save credit enforcement.");
    } finally {
      setTogglingEnforce(false);
    }
  }

  const low = view ? view.balance < 1000 : false;

  return (
    <section className="mb-6 rounded-xl border border-border bg-card" aria-labelledby="credits-heading">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4">
        <div className="min-w-0">
          <h2 id="credits-heading" className="flex items-center gap-2 font-semibold">
            <Coins className="h-4 w-4" aria-hidden /> AI credits
          </h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Every model call is debited (provider cost × {view?.markup ?? 1.5}); agent outcomes are priced per agent. 1,000 credits = $1.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading} aria-label="Refresh credits">
          {loading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <RefreshCw className="h-4 w-4" aria-hidden />}
          Refresh
        </Button>
      </div>

      <div className="px-5 py-4">
        {error && (
          <Banner tone="error" onDismiss={() => setError(null)}>
            {error}
          </Banner>
        )}
        {notice && (
          <Banner tone="success" onDismiss={() => setNotice(null)}>
            {notice}
          </Banner>
        )}

        {loading && !view && <Loading label="Loading credits…" />}
        {!loading && !view && error && <ErrorState message={error} onRetry={() => void load()} />}

        {view && (
          <>
            <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
              <div className={cn("rounded-xl border p-5", low ? "border-amber-500/40 bg-amber-500/5" : "border-border")}>
                <p className="text-xs uppercase tracking-wide text-muted-foreground">Balance</p>
                <p className="mt-1 text-3xl font-semibold tabular-nums" aria-live="polite">
                  {formatCredits(view.balance)}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">≈ {formatCreditsAsMoney(view.balance)}</p>
                {low && <p className="mt-2 text-xs font-medium text-amber-700 dark:text-amber-300">Running low — buy a pack to keep agents running.</p>}
                <div className="mt-4">
                  <Checkbox
                    label={
                      <span>
                        <span className="font-medium">Enforce credits</span>
                        <span className="block text-xs text-muted-foreground">Refuse model calls once the balance is exhausted.</span>
                      </span>
                    }
                    checked={view.creditsEnforced}
                    disabled={togglingEnforce}
                    onChange={(e) => void toggleEnforce(e.target.checked)}
                  />
                </div>
              </div>

              <div>
                <h3 className="mb-2 text-sm font-semibold">Buy credits</h3>
                <ul className="grid gap-3 sm:grid-cols-3" aria-label="Credit packs">
                  {view.packs.map((p) => (
                    <li key={p.id} className="flex flex-col rounded-xl border border-border p-4">
                      <p className="font-medium">{p.name}</p>
                      <p className="mt-1 text-xl font-semibold tabular-nums">{formatCredits(p.credits)}</p>
                      <p className="text-xs text-muted-foreground">{fmtMoney(p.price_minor, p.currency)} · {p.blurb}</p>
                      <Button
                        size="sm"
                        touch
                        className="mt-3 w-full"
                        onClick={() => void buy(p)}
                        disabled={buying !== null}
                        aria-label={`Buy ${p.name} pack for ${fmtMoney(p.price_minor, p.currency)}`}
                      >
                        {buying === p.id ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <ShoppingCart className="h-4 w-4" aria-hidden />}
                        Buy
                      </Button>
                    </li>
                  ))}
                </ul>
                {view.provider === "simulated" && (
                  <p className="mt-2 text-xs text-muted-foreground">Payments run in simulated mode: checkout opens a page where you confirm a test payment — no card is charged.</p>
                )}
              </div>
            </div>

            <h3 className="mb-2 mt-6 text-sm font-semibold">Ledger</h3>
            {view.ledger.length === 0 ? (
              <Empty icon={<Coins className="h-5 w-5" />} title="No credit activity yet" text="Usage, purchases and outcome charges will appear here." />
            ) : (
              <TableScroller label="Credit ledger">
                <table className="w-full min-w-[560px] text-sm">
                  <thead className={THEAD}>
                    <tr>
                      <th className={TH}>When</th>
                      <th className={TH}>Kind</th>
                      <th className={TH}>Note</th>
                      <th className={cn(TH, "text-right")}>Credits</th>
                      <th className={cn(TH, "text-right")}>Balance</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {view.ledger.map((e) => (
                      <tr key={e.id}>
                        <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">{fmtDate(e.created_at)}</td>
                        <td className="px-3 py-2">
                          <Pill tone={KIND_TONE[e.kind] ?? "neutral"}>{e.kind}</Pill>
                        </td>
                        <td className="max-w-[260px] truncate px-3 py-2 text-muted-foreground" title={e.note ?? undefined}>
                          {e.note ?? (e.ref_kind ? `${e.ref_kind} ${e.ref_id ?? ""}` : "—")}
                        </td>
                        <td className={cn("px-3 py-2 text-right tabular-nums", e.credits < 0 ? "text-red-700 dark:text-red-300" : "text-emerald-700 dark:text-emerald-300")}>
                          {e.credits > 0 ? "+" : ""}
                          {new Intl.NumberFormat().format(e.credits)}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">{new Intl.NumberFormat().format(e.balance_after)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableScroller>
            )}

            {view.purchases.some((p) => p.status === "pending") && (
              <p className="mt-3 text-xs text-muted-foreground">
                {view.purchases.filter((p) => p.status === "pending").length} checkout(s) still pending — credits land once the payment is confirmed.
              </p>
            )}
          </>
        )}
      </div>
    </section>
  );
}
