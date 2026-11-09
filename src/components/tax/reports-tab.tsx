"use client";

import { useState } from "react";
import { Download, Loader2, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { TableScroller, TH, THEAD } from "@/components/ui/table-scroller";
import { api, Banner, Empty, Field } from "@/components/finance/shared";
import { REGIMES, REGIME_INFO, type Regime } from "@/lib/tax-compliance/regimes";
import { fmtMoney } from "@/lib/money/format";
import { SPIN, type Report } from "./types";

function lastMonth(): { from: string; to: string } {
  const n = new Date();
  const a = new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth() - 1, 1));
  const b = new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), 0));
  return { from: a.toISOString().slice(0, 10), to: b.toISOString().slice(0, 10) };
}
const MONEYISH = /value|taxable|igst|cgst|sgst|amount|net|tax$|goods|services|sales|collected|exempt|vat$|gross/i;

export function ReportsTab({ defaultRegime, onPrepared }: { defaultRegime: Regime; onPrepared: () => void }) {
  const [regime, setRegime] = useState<Regime>(defaultRegime === "generic" ? "eu_vat" : defaultRegime);
  const [range, setRange] = useState(lastMonth());
  const [report, setReport] = useState<Report | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const qs = `regime=${regime}&from=${range.from}&to=${range.to}`;

  async function run() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      setReport((await api<{ report: Report }>(`/api/tax/reports?${qs}`)).report);
    } catch (e) {
      setReport(null);
      setError(e instanceof Error ? e.message : "Could not build the report.");
    } finally {
      setBusy(false);
    }
  }
  async function prepare() {
    setBusy(true);
    setError(null);
    try {
      await api("/api/tax/reports", { method: "POST", body: JSON.stringify({ regime, from: range.from, to: range.to }) });
      setNotice("Filing prepared. Mark it as filed under Filings once you have submitted it yourself.");
      onPrepared();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not prepare the filing.");
    } finally {
      setBusy(false);
    }
  }
  function downloadJson() {
    if (!report) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `tax-${regime}-${range.from}_${range.to}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }
  const fmt = (v: string | number | null, col: string) => (typeof v === "number" && MONEYISH.test(col) && !/rate/i.test(col) && report ? fmtMoney(v, report.currency) : v === null ? "" : String(v));

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-5 sm:items-end">
        <Field label="Regime">
          <Select value={regime} onChange={(e) => setRegime(e.target.value as Regime)}>
            {REGIMES.filter((r) => r !== "generic").map((r) => <option key={r} value={r}>{REGIME_INFO[r].label}</option>)}
          </Select>
        </Field>
        <Field label="From"><Input type="date" value={range.from} onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))} /></Field>
        <Field label="To"><Input type="date" value={range.to} onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))} /></Field>
        <Button type="button" touch onClick={() => void run()} disabled={busy || !range.from || !range.to}>
          {busy ? <Loader2 className={SPIN} aria-hidden /> : <Play className="h-4 w-4" aria-hidden />} Run report
        </Button>
      </div>
      {error && <Banner tone="error" onDismiss={() => setError(null)}>{error}</Banner>}
      {notice && <Banner tone="success" onDismiss={() => setNotice(null)}>{notice}</Banner>}
      {!report && !error && <Empty title="No report yet" text="Pick a period and run the report. Figures are a preparation aid - verify with your accountant before filing." />}
      {report && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-semibold">{report.title}</h2>
            <span className="text-xs text-muted-foreground">{report.period.from} to {report.period.to} - {report.currency} - hash {report.report_hash.slice(0, 12)}</span>
            <div className="ml-auto flex flex-wrap gap-2">
              <a className="inline-flex items-center gap-1 rounded-md border border-border px-3 py-2 text-sm hover:bg-secondary" href={`/api/tax/reports?${qs}&format=csv`}><Download className="h-4 w-4" aria-hidden /> CSV</a>
              <Button type="button" variant="outline" touch onClick={downloadJson}><Download className="h-4 w-4" aria-hidden /> JSON</Button>
              <Button type="button" touch onClick={() => void prepare()} disabled={busy}>Prepare filing</Button>
            </div>
          </div>
          {report.warnings.length > 0 && (
            <Banner tone="warn">
              <p className="font-medium">{report.warnings.length} warning(s)</p>
              <ul className="mt-1 list-disc pl-5 text-sm">{report.warnings.slice(0, 30).map((w) => <li key={w}>{w}</li>)}</ul>
            </Banner>
          )}
          {report.fx_notes.length > 0 && <p className="text-xs text-muted-foreground">FX: {report.fx_notes.join("; ")}</p>}
          {report.sections.map((sec) => (
            <section key={sec.key} aria-label={sec.title}>
              <h3 className="mb-1 text-sm font-medium">{sec.title}</h3>
              {sec.rows.length === 0 ? <p className="text-sm text-muted-foreground">No rows.</p> : (
                <TableScroller label={sec.title}>
                  <table className="w-full text-sm">
                    <thead className={THEAD}><tr>{sec.columns.map((c) => <th key={c} scope="col" className={TH}>{c}</th>)}</tr></thead>
                    <tbody>{sec.rows.map((row, i) => <tr key={i} className="border-t border-border">{row.map((v, j) => <td key={j} className="px-3 py-2">{fmt(v, sec.columns[j] ?? "")}</td>)}</tr>)}</tbody>
                  </table>
                </TableScroller>
              )}
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
