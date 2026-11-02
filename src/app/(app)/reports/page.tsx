"use client";

import { useCallback, useEffect, useState } from "react";
import { BarChart3, Download, Loader2, RefreshCw, TrendingDown, TrendingUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { TableScroller, TH, THEAD } from "@/components/ui/table-scroller";
import { isAbortError, useAbortable } from "@/components/ui/hooks";
import { PageContainer } from "@/components/page-container";
import { cn } from "@/lib/utils";
import { fmtMoney } from "@/lib/money/format";
import { api, Banner, Empty, Field, Loading, todayLocalISODate } from "@/components/finance/shared";

interface JobCost {
  key: string; job_kind: string; job_id: string; label: string; currency: string;
  revenue_minor: number; expense_minor: number; time_minor: number; stock_minor: number; cost_minor: number; margin_minor: number; margin_pct: number | null;
}
interface Report { jobs: JobCost[]; totals: Omit<JobCost, "key" | "job_kind" | "job_id" | "label" | "currency"> & { currencies: string[] } }
interface ProviderInfo { id: string; configured: boolean; active: boolean }

type Preset = "30d" | "90d" | "ytd" | "custom";
const PRESETS: ReadonlyArray<[Preset, string]> = [
  ["30d", "30 days"],
  ["90d", "90 days"],
  ["ytd", "This year"],
  ["custom", "Custom"],
];
const spinner = <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />;

function presetRange(p: Preset): { from: string; to: string } {
  const to = todayLocalISODate();
  if (p === "30d") return { from: todayLocalISODate(-30), to };
  if (p === "90d") return { from: todayLocalISODate(-90), to };
  if (p === "ytd") return { from: `${new Date().getFullYear()}-01-01`, to };
  return { from: todayLocalISODate(-30), to };
}

export default function ReportsPage() {
  const [preset, setPreset] = useState<Preset>("30d");
  const [range, setRange] = useState(() => presetRange("30d"));
  const [report, setReport] = useState<Report | null>(null);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [exporting, setExporting] = useState<string | null>(null);
  const nextSignal = useAbortable();

  const qs = useCallback(() => {
    const from = new Date(range.from + "T00:00:00").toISOString();
    const to = new Date(range.to + "T23:59:59.999").toISOString();
    return `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
  }, [range]);

  const load = useCallback(async () => {
    if (!range.from || !range.to) return;
    const signal = nextSignal();
    setLoading(true);
    setError(null);
    try {
      const [r, p] = await Promise.all([
        api<{ report: Report }>(`/api/reports/job-costing?${qs()}`, { signal }),
        api<{ providers: ProviderInfo[] }>("/api/export/accounting", { signal }).catch((e) => {
          if (isAbortError(e)) throw e;
          return { providers: [] as ProviderInfo[] };
        }),
      ]);
      setReport(r.report);
      setProviders(p.providers);
    } catch (e) {
      if (isAbortError(e)) return;
      setError(e instanceof Error ? e.message : "Could not load the report.");
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }, [qs, range.from, range.to, nextSignal]);
  useEffect(() => {
    void load();
  }, [load]);

  function pick(p: Preset) {
    setPreset(p);
    if (p !== "custom") setRange(presetRange(p));
  }

  async function exportCsv(entity: "invoices" | "expenses" | "payments") {
    setExporting(entity);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/export/accounting?entity=${entity}&${qs()}`);
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.detail ?? data?.error ?? `Export failed (${res.status})`);
      }
      const blob = await res.blob();
      const name = res.headers.get("content-disposition")?.match(/filename="([^"]+)"/)?.[1] ?? `${entity}.csv`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      a.click();
      URL.revokeObjectURL(url);
      setNotice(`Downloaded ${name} (${res.headers.get("x-export-rows") ?? "?"} rows).`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Export failed.");
    } finally {
      setExporting(null);
    }
  }

  const t = report?.totals;
  const ccy = report?.totals.currencies[0] ?? "USD";
  const mixed = (report?.totals.currencies.length ?? 0) > 1;
  const active = providers.find((p) => p.active);
  const jobCount = report ? report.jobs.filter((j) => j.key !== "none:").length : 0;

  return (
    <PageContainer
      wide
      title="Reports"
      description="What each job earned after expenses, labour and materials — and the books, exported for your accountant."
      tooltip="Revenue counts invoices paid in the range. Costs count expenses, completed time at its rate, and stock consumed at your cost price, logged against the job."
      actions={
        <Button variant="outline" size="icon" touch onClick={() => void load()} disabled={loading} aria-label="Refresh">
          {loading ? spinner : <RefreshCw className="h-4 w-4" aria-hidden />}
        </Button>
      }
    >
      <div className="mb-6 flex flex-wrap items-end gap-3">
        <div role="group" aria-label="Date range" className="flex max-w-full items-center gap-1 overflow-x-auto rounded-lg border border-border bg-card p-1">
          {PRESETS.map(([p, l]) => (
            <button
              key={p}
              type="button"
              aria-pressed={preset === p}
              onClick={() => pick(p)}
              className={cn(
                "inline-flex min-h-11 shrink-0 items-center whitespace-nowrap rounded-md px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none sm:min-h-8",
                preset === p ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground"
              )}
            >
              {l}
            </button>
          ))}
        </div>
        {preset === "custom" && (
          <div className="flex flex-wrap items-end gap-2">
            <Field label="From">
              <Input type="date" value={range.from} max={range.to} onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))} />
            </Field>
            <Field label="To">
              <Input type="date" value={range.to} min={range.from} onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))} />
            </Field>
          </div>
        )}
      </div>

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
      {mixed && <Banner tone="warn">Totals mix currencies ({report?.totals.currencies.join(", ")}). Per-job figures are exact.</Banner>}

      {loading && !report ? (
        <Loading label="Loading report…" />
      ) : report && t ? (
        <div aria-busy={loading || undefined}>
          <section aria-label="Summary" className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Card label="Revenue" value={fmtMoney(t.revenue_minor, ccy)} sub="Paid invoices" />
            <Card label="Costs" value={fmtMoney(t.cost_minor, ccy)} sub={`Expenses ${fmtMoney(t.expense_minor, ccy)} · Time ${fmtMoney(t.time_minor, ccy)} · Stock ${fmtMoney(t.stock_minor, ccy)}`} />
            <Card
              label="Margin"
              value={fmtMoney(t.margin_minor, ccy)}
              tone={t.margin_minor < 0 ? "bad" : t.margin_minor > 0 ? "good" : undefined}
              sub={t.margin_pct === null ? "No revenue in range" : `${t.margin_pct}% of revenue`}
            />
            <Card label="Jobs" value={String(jobCount)} sub={report.jobs.some((j) => j.key === "none:") ? "plus unassigned costs" : "with activity"} />
          </section>

          {report.jobs.length === 0 ? (
            <Empty
              icon={<BarChart3 className="h-5 w-5" />}
              title="Nothing in this range yet"
              text="Paid invoices, expenses and time logged against jobs will show up here."
              action={
                preset !== "ytd" ? (
                  <Button variant="outline" onClick={() => pick("ytd")}>
                    Show this year
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <>
              <ul className="space-y-2 sm:hidden">
                {report.jobs.map((j) => (
                  <li key={j.key} className="rounded-xl border border-border bg-card p-3">
                    <div className="flex items-start justify-between gap-2">
                      <p className="min-w-0 truncate font-medium">{j.label}</p>
                      <Margin j={j} />
                    </div>
                    <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
                      <dt className="text-muted-foreground">Revenue</dt>
                      <dd className="text-right tabular-nums">{fmtMoney(j.revenue_minor, j.currency)}</dd>
                      <dt className="text-muted-foreground">Costs</dt>
                      <dd className="text-right tabular-nums">{fmtMoney(j.cost_minor, j.currency)}</dd>
                    </dl>
                  </li>
                ))}
              </ul>
              <div className="hidden sm:block">
                <TableScroller label="Job costing">
                  <table className="w-full min-w-[40rem] text-sm">
                    <thead className={THEAD}>
                      <tr>
                        <th scope="col" className={TH}>Job</th>
                        <th scope="col" className={cn(TH, "text-right")}>Revenue</th>
                        <th scope="col" className={cn(TH, "text-right")}>Expenses</th>
                        <th scope="col" className={cn(TH, "text-right")}>Time</th>
                        <th scope="col" className={cn(TH, "text-right")}>Stock</th>
                        <th scope="col" className={cn(TH, "text-right")}>Margin</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {report.jobs.map((j) => (
                        <tr key={j.key} className={cn(j.key === "none:" && "text-muted-foreground")}>
                          <td className="px-3 py-2">
                            <span className="font-medium">{j.label}</span>
                            {j.key !== "none:" && <span className="ml-2 text-xs capitalize text-muted-foreground">{j.job_kind}</span>}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums">{fmtMoney(j.revenue_minor, j.currency)}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{fmtMoney(j.expense_minor, j.currency)}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{fmtMoney(j.time_minor, j.currency)}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{fmtMoney(j.stock_minor, j.currency)}</td>
                          <td className="px-3 py-2 text-right">
                            <Margin j={j} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableScroller>
              </div>
            </>
          )}
        </div>
      ) : null}

      <section aria-labelledby="export-heading" className="mt-8 rounded-xl border border-border bg-card p-4 sm:p-5">
        <h2 id="export-heading" className="text-sm font-semibold">
          Accounting export
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          CSV for the selected range{active ? ` · provider: ${active.id}${active.configured ? "" : " (not configured, so CSV is used)"}` : ""}.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          {(["invoices", "expenses", "payments"] as const).map((e) => (
            <Button key={e} variant="outline" touch onClick={() => void exportCsv(e)} disabled={exporting !== null} className="capitalize">
              {exporting === e ? spinner : <Download className="h-4 w-4" aria-hidden />} {e} CSV
            </Button>
          ))}
        </div>
      </section>
    </PageContainer>
  );
}

function Card({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "good" | "bad" }) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={cn("mt-1 text-xl font-semibold tabular-nums sm:text-2xl", tone === "good" && "text-emerald-700 dark:text-emerald-300", tone === "bad" && "text-red-700 dark:text-red-300")}>
        {tone === "bad" && <span className="sr-only">Loss: </span>}
        {value}
      </p>
      {sub && (
        <p className="mt-1 truncate text-xs text-muted-foreground" title={sub}>
          {sub}
        </p>
      )}
    </div>
  );
}

function Margin({ j }: { j: JobCost }) {
  const neg = j.margin_minor < 0;
  return (
    <span className={cn("inline-flex items-center gap-1 font-medium tabular-nums", neg ? "text-red-700 dark:text-red-300" : j.margin_minor > 0 ? "text-emerald-700 dark:text-emerald-300" : "")}>
      {neg ? <TrendingDown className="h-3.5 w-3.5" aria-hidden /> : j.margin_minor > 0 ? <TrendingUp className="h-3.5 w-3.5" aria-hidden /> : null}
      {neg && <span className="sr-only">Loss </span>}
      {fmtMoney(j.margin_minor, j.currency)}
      {j.margin_pct !== null && <span className="text-xs font-normal text-muted-foreground">({j.margin_pct}%)</span>}
    </span>
  );
}
