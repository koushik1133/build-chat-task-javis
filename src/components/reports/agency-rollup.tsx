"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Building2 } from "lucide-react";
import { Banner, ErrorState, SkeletonList } from "@/components/ui/feedback";
import { TableScroller, TH, THEAD } from "@/components/ui/table-scroller";
import { isAbortError, useAbortable } from "@/components/ui/hooks";
import { api } from "@/components/finance/shared";
import { fmtMoney } from "@/lib/money/format";
import { cn } from "@/lib/utils";

interface Row {
  org: { id: string; name: string; slug: string; archived: boolean };
  currency: string; revenue_minor: number; paid_invoices: number; open_quotes: number; open_quotes_minor: number; bookings: number; open_tickets: number; ai_cost_micros: number; ai_calls: number;
}
interface Report { rows: Row[]; totals: { clients: number; revenue_minor: number; open_quotes: number; open_quotes_minor: number; bookings: number; open_tickets: number; ai_cost_micros: number; currencies: string[] } }

const usd = (micros: number) => `$${(micros / 1e6).toFixed(2)}`;

/** Agency roll-up on the Reports page. Renders nothing for workspaces without client workspaces. */
export function AgencyRollup({ qs }: { qs: string }) {
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const nextSignal = useAbortable();

  const load = useCallback(async () => {
    const signal = nextSignal();
    setLoading(true);
    setError(null);
    try {
      const r = await api<{ report: Report }>(`/api/agency/rollup?${qs}`, { signal });
      setReport(r.report);
    } catch (e) {
      if (isAbortError(e)) return;
      setError(e instanceof Error ? e.message : "Could not load the client roll-up.");
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }, [qs, nextSignal]);
  useEffect(() => {
    void load();
  }, [load]);

  if (!loading && !error && (!report || report.rows.length === 0)) return null;
  const t = report?.totals;
  const ccy = t?.currencies[0] ?? "USD";

  return (
    <section aria-labelledby="rollup-heading" className="mt-8 rounded-xl border border-border bg-card p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 id="rollup-heading" className="flex items-center gap-2 text-sm font-semibold">
            <Building2 className="h-4 w-4" aria-hidden /> Client workspaces
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">Revenue, pipeline, bookings, tickets and AI spend per client for the selected range.</p>
        </div>
        <Link href="/agency/clients" className="inline-flex min-h-11 items-center rounded-md text-sm text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-0">
          Manage clients
        </Link>
      </div>
      {error && report && (
        <Banner tone="error" className="mt-3" onDismiss={() => setError(null)}>
          {error}
        </Banner>
      )}
      {error && !report ? (
        <ErrorState message={error} onRetry={() => void load()} className="mt-4" />
      ) : loading && !report ? (
        <SkeletonList count={3} itemClassName="h-10" className="mt-4" label="Loading roll-up…" />
      ) : report && t ? (
        <div className="mt-4" aria-busy={loading || undefined}>
          <p className="sr-only" role="status" aria-live="polite">{loading ? "Updating the client roll-up…" : `Roll-up for ${t.clients} client${t.clients === 1 ? "" : "s"} ready.`}</p>
          {t.currencies.length > 1 && <Banner tone="warn">Totals mix currencies ({t.currencies.join(", ")}). Per-client figures are exact.</Banner>}
          <ul className="space-y-2 sm:hidden">
            {report.rows.map((r) => (
              <li key={r.org.id} className="rounded-lg border border-border p-3">
                <p className="truncate font-medium">{r.org.name}{r.org.archived && <span className="ml-2 text-xs font-normal text-muted-foreground">archived</span>}</p>
                <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
                  <dt className="text-muted-foreground">Revenue</dt><dd className="text-right tabular-nums">{fmtMoney(r.revenue_minor, r.currency)}</dd>
                  <dt className="text-muted-foreground">Open quotes</dt><dd className="text-right tabular-nums">{r.open_quotes} · {fmtMoney(r.open_quotes_minor, r.currency)}</dd>
                  <dt className="text-muted-foreground">Bookings</dt><dd className="text-right tabular-nums">{r.bookings}</dd>
                  <dt className="text-muted-foreground">Open tickets</dt><dd className="text-right tabular-nums">{r.open_tickets}</dd>
                  <dt className="text-muted-foreground">AI spend</dt><dd className="text-right tabular-nums">{usd(r.ai_cost_micros)}</dd>
                </dl>
              </li>
            ))}
          </ul>
          <div className="hidden sm:block">
            <TableScroller label="Client roll-up">
              <table className="w-full min-w-[44rem] text-sm">
                <thead className={THEAD}>
                  <tr>
                    <th scope="col" className={TH}>Client</th>
                    <th scope="col" className={cn(TH, "text-right")}>Revenue</th>
                    <th scope="col" className={cn(TH, "text-right")}>Open quotes</th>
                    <th scope="col" className={cn(TH, "text-right")}>Bookings</th>
                    <th scope="col" className={cn(TH, "text-right")}>Open tickets</th>
                    <th scope="col" className={cn(TH, "text-right")}>AI spend</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {report.rows.map((r) => (
                    <tr key={r.org.id}>
                      <td className="px-3 py-2 font-medium">{r.org.name}{r.org.archived && <span className="ml-2 text-xs text-muted-foreground">archived</span>}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmtMoney(r.revenue_minor, r.currency)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{r.open_quotes} · {fmtMoney(r.open_quotes_minor, r.currency)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{r.bookings}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{r.open_tickets}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{usd(r.ai_cost_micros)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="border-t border-border bg-secondary/30 font-medium">
                  <tr>
                    <td className="px-3 py-2">Total · {t.clients} client{t.clients === 1 ? "" : "s"}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmtMoney(t.revenue_minor, ccy)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{t.open_quotes} · {fmtMoney(t.open_quotes_minor, ccy)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{t.bookings}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{t.open_tickets}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{usd(t.ai_cost_micros)}</td>
                  </tr>
                </tfoot>
              </table>
            </TableScroller>
          </div>
        </div>
      ) : null}
    </section>
  );
}
