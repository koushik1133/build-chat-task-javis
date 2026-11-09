"use client";

import { useEffect, useMemo, useState } from "react";
import { Plus, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { fmtMoney, STATUS_TONE } from "@/lib/money/format";
import { computeTotals as computeTaxTotals, rateLabel, type TaxBreakdownRow, type TaxRateLike } from "@/lib/money/tax";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input, Select } from "@/components/ui/input";

export interface LineItem {
  description: string;
  qty: number;
  unit_minor: number;
  tax_rate_bp: number;
  tax_rate_id?: string | null;
  product_id?: string;
}

export interface TaxRateOption extends TaxRateLike {
  id: string;
  name: string;
  rate_bp: number;
  compound: boolean;
  is_default: boolean;
  active: boolean;
}

export function StatusPill({ status }: { status: string }) {
  return (
    <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium capitalize", STATUS_TONE[status] ?? "bg-secondary")}>
      {status.replace(/_/g, " ")}
    </span>
  );
}

export function ItemsTable({ items, currency, totals, breakdown }: {
  items: LineItem[];
  currency: string;
  totals: { subtotal_minor: number; tax_minor: number; total_minor: number };
  breakdown?: TaxBreakdownRow[];
}) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-sm">
        <thead className="bg-secondary/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
          <tr>
            <th className="px-3 py-2">Description</th>
            <th className="px-3 py-2 text-right">Qty</th>
            <th className="px-3 py-2 text-right">Unit</th>
            <th className="px-3 py-2 text-right">Tax</th>
            <th className="px-3 py-2 text-right">Amount</th>
          </tr>
        </thead>
        <tbody>
          {items.map((it, i) => (
            <tr key={i} className="border-t border-border">
              <td className="px-3 py-2">{it.description}</td>
              <td className="px-3 py-2 text-right tabular-nums">{it.qty}</td>
              <td className="px-3 py-2 text-right tabular-nums">{fmtMoney(it.unit_minor, currency)}</td>
              <td className="px-3 py-2 text-right tabular-nums">{it.tax_rate_id ? "see below" : `${(it.tax_rate_bp / 100).toFixed(2)}%`}</td>
              <td className="px-3 py-2 text-right tabular-nums">{fmtMoney(Math.floor(it.qty * it.unit_minor + 0.5), currency)}</td>
            </tr>
          ))}
          {items.length === 0 && (
            <tr><td colSpan={5} className="px-3 py-6 text-center text-muted-foreground">No line items</td></tr>
          )}
        </tbody>
        <tfoot className="border-t border-border text-sm">
          <tr><td colSpan={4} className="px-3 py-1.5 text-right text-muted-foreground">Subtotal</td><td className="px-3 py-1.5 text-right tabular-nums">{fmtMoney(totals.subtotal_minor, currency)}</td></tr>
          {breakdown && breakdown.length > 0 ? (
            breakdown.map((b, i) => (
              <tr key={i}><td colSpan={4} className="px-3 py-1.5 text-right text-muted-foreground">{rateLabel(b)}</td><td className="px-3 py-1.5 text-right tabular-nums">{fmtMoney(b.tax_minor, currency)}</td></tr>
            ))
          ) : (
            <tr><td colSpan={4} className="px-3 py-1.5 text-right text-muted-foreground">Tax</td><td className="px-3 py-1.5 text-right tabular-nums">{fmtMoney(totals.tax_minor, currency)}</td></tr>
          )}
          <tr className="font-semibold"><td colSpan={4} className="px-3 py-2 text-right">Total</td><td className="px-3 py-2 text-right tabular-nums">{fmtMoney(totals.total_minor, currency)}</td></tr>
        </tfoot>
      </table>
    </div>
  );
}

export function PublicShell({ children, business, title }: { children: React.ReactNode; business?: string; title: string }) {
  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8 sm:py-12">
      <header className="mb-6 flex items-baseline justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-wide text-muted-foreground">{business ?? ""}</p>
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        </div>
      </header>
      {children}
    </div>
  );
}

/** Legacy inline-rate totals (no catalogue). Kept for callers that have no rates loaded. */
export function computeTotalsClient(items: LineItem[]) {
  let subtotal_minor = 0, tax_minor = 0;
  for (const it of items) {
    const s = Math.floor(it.qty * it.unit_minor + 0.5);
    subtotal_minor += s;
    tax_minor += Math.floor((s * (it.tax_rate_bp || 0)) / 10_000 + 0.5);
  }
  return { subtotal_minor, tax_minor, total_minor: subtotal_minor + tax_minor };
}

/** Loads the org tax catalogue + inclusive/rounding prefs once for an editor. */
export function useTaxRates(): { rates: TaxRateOption[]; inclusive: boolean; rounding: "per_line" | "per_total" } {
  const [rates, setRates] = useState<TaxRateOption[]>([]);
  const [inclusive, setInclusive] = useState(false);
  const [rounding, setRounding] = useState<"per_line" | "per_total">("per_line");
  useEffect(() => {
    const ctrl = new AbortController();
    fetch("/api/tax-rates", { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : { rates: [] }))
      .then((d: { rates?: TaxRateOption[] }) => setRates(d.rates ?? []))
      .catch(() => setRates([]));
    fetch("/api/billing/settings", { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { settings?: { prices_include_tax?: boolean; tax_rounding?: "per_line" | "per_total" } } | null) => {
        if (!d?.settings) return;
        setInclusive(Boolean(d.settings.prices_include_tax));
        setRounding(d.settings.tax_rounding === "per_total" ? "per_total" : "per_line");
      })
      .catch(() => undefined);
    return () => ctrl.abort();
  }, []);
  return { rates, inclusive, rounding };
}

export const BLANK_ITEM: LineItem = { description: "", qty: 1, unit_minor: 0, tax_rate_bp: 0 };

/**
 * Line-item editor shared by quotes, invoices, recurring schedules and credit
 * notes. Tax is picked from the catalogue when one exists; otherwise a manual
 * percentage is typed. Totals (with breakdown) are computed client-side.
 */
export function LineItemsEditor({ items, onChange, rates, max = 100, currency }: {
  items: LineItem[];
  onChange: (next: LineItem[]) => void;
  rates: TaxRateOption[];
  max?: number;
  /** When given, each line shows its net amount (useful on phones where columns stack). */
  currency?: string;
}) {
  const hasCatalogue = rates.length > 0;
  const setItem = (i: number, patch: Partial<LineItem>) => onChange(items.map((it, idx) => (idx === i ? { ...it, ...patch } : it)));
  return (
    <fieldset className="min-w-0">
      <legend className="mb-2 text-xs font-medium">Line items</legend>
      <ol className="space-y-3" aria-label="Line items">
        {items.map((it, i) => {
          // Labels stay visible on phones (fields stack); from `sm` up only the first row shows them as column headers.
          const srOnly = i > 0 ? "sm:[&>label]:sr-only" : "";
          const net = Math.floor(it.qty * it.unit_minor + 0.5);
          return (
            <li key={i} className="rounded-lg border border-border p-3 sm:border-0 sm:p-0">
              <div className="grid grid-cols-2 items-end gap-2 sm:grid-cols-[1fr_5rem_7rem_8rem_2.75rem]">
                <Field label={`Description${i > 0 ? ` (line ${i + 1})` : ""}`} className={`col-span-2 sm:col-span-1 ${srOnly}`}>
                  <Input placeholder="Service or product" value={it.description} onChange={(e) => setItem(i, { description: e.target.value })} />
                </Field>
                <Field label="Qty" className={srOnly}>
                  <Input type="number" inputMode="decimal" min={0} step="0.01" value={it.qty} onChange={(e) => setItem(i, { qty: Number(e.target.value) || 0 })} />
                </Field>
                <Field label="Unit price" className={srOnly}>
                  <Input type="number" inputMode="decimal" min={0} step="0.01" value={(it.unit_minor / 100).toString()} onChange={(e) => setItem(i, { unit_minor: Math.round((Number(e.target.value) || 0) * 100) })} />
                </Field>
                {hasCatalogue ? (
                  <Field label="Tax rate" className={srOnly}>
                    <Select value={it.tax_rate_id ?? ""} onChange={(e) => setItem(i, { tax_rate_id: e.target.value || null, tax_rate_bp: 0 })}>
                      <option value="">No tax</option>
                      {rates.map((r) => (
                        <option key={r.id} value={r.id}>{rateLabel(r)}{r.compound ? " (compound)" : ""}</option>
                      ))}
                    </Select>
                  </Field>
                ) : (
                  <Field label="Tax %" className={srOnly}>
                    <Input type="number" inputMode="decimal" min={0} max={100} step="0.01" value={(it.tax_rate_bp / 100).toString()} onChange={(e) => setItem(i, { tax_rate_bp: Math.round((Number(e.target.value) || 0) * 100) })} />
                  </Field>
                )}
                <Button type="button" variant="ghost" size="icon" touch className="justify-self-end" onClick={() => onChange(items.filter((_, idx) => idx !== i))} aria-label={`Remove line ${i + 1}`} disabled={items.length === 1}>
                  <X className="h-4 w-4" aria-hidden />
                </Button>
              </div>
              {currency && (
                <p className="mt-1.5 text-right text-xs tabular-nums text-muted-foreground sm:hidden">
                  Line amount <span className="font-medium text-foreground">{fmtMoney(net, currency)}</span>
                </p>
              )}
            </li>
          );
        })}
      </ol>
      <Button type="button" size="sm" variant="outline" touch className="mt-3" onClick={() => onChange([...items, { ...BLANK_ITEM, tax_rate_id: rates.find((r) => r.is_default)?.id ?? null }])} disabled={items.length >= max}>
        <Plus className="h-3.5 w-3.5" aria-hidden /> Add line
      </Button>
    </fieldset>
  );
}

/** Totals + per-rate breakdown for an editor footer. */
export function useDocTotals(items: LineItem[], rates: TaxRateOption[], opts: { inclusive: boolean; rounding: "per_line" | "per_total" }) {
  return useMemo(() => computeTaxTotals(items, rates, opts), [items, rates, opts]);
}

export function TotalsSummary({ totals, currency, inclusive }: { totals: ReturnType<typeof computeTaxTotals>; currency: string; inclusive?: boolean }) {
  const rows: Array<[string, number]> = [["Subtotal", totals.subtotal_minor]];
  if (totals.breakdown.length > 0) for (const b of totals.breakdown) rows.push([rateLabel(b), b.tax_minor]);
  else rows.push(["Tax", totals.tax_minor]);
  return (
    <dl className="grid w-full grid-cols-[auto_auto] justify-between gap-x-4 gap-y-0.5 text-xs tabular-nums sm:w-auto sm:min-w-[16rem]" aria-label="Totals">
      {rows.map(([label, minor]) => (
        <div key={label} className="contents">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="text-right">{fmtMoney(minor, currency)}</dd>
        </div>
      ))}
      <dt className="mt-1 border-t border-border pt-1 text-sm font-semibold text-foreground">Total</dt>
      <dd className="mt-1 border-t border-border pt-1 text-right text-sm font-semibold text-foreground">{fmtMoney(totals.total_minor, currency)}</dd>
      {inclusive && <dd className="col-span-2 text-[11px] text-muted-foreground">Prices include tax</dd>}
    </dl>
  );
}
