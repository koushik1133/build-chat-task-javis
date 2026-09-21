"use client";

import { cn } from "@/lib/utils";
import { fmtMoney, STATUS_TONE } from "@/lib/money/format";

export interface LineItem {
  description: string;
  qty: number;
  unit_minor: number;
  tax_rate_bp: number;
}

export function StatusPill({ status }: { status: string }) {
  return (
    <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium capitalize", STATUS_TONE[status] ?? "bg-secondary")}>
      {status.replace("_", " ")}
    </span>
  );
}

export function ItemsTable({ items, currency, totals }: {
  items: LineItem[];
  currency: string;
  totals: { subtotal_minor: number; tax_minor: number; total_minor: number };
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
              <td className="px-3 py-2 text-right tabular-nums">{(it.tax_rate_bp / 100).toFixed(2)}%</td>
              <td className="px-3 py-2 text-right tabular-nums">{fmtMoney(Math.floor(it.qty * it.unit_minor + 0.5), currency)}</td>
            </tr>
          ))}
          {items.length === 0 && (
            <tr><td colSpan={5} className="px-3 py-6 text-center text-muted-foreground">No line items</td></tr>
          )}
        </tbody>
        <tfoot className="border-t border-border text-sm">
          <tr><td colSpan={4} className="px-3 py-1.5 text-right text-muted-foreground">Subtotal</td><td className="px-3 py-1.5 text-right tabular-nums">{fmtMoney(totals.subtotal_minor, currency)}</td></tr>
          <tr><td colSpan={4} className="px-3 py-1.5 text-right text-muted-foreground">Tax</td><td className="px-3 py-1.5 text-right tabular-nums">{fmtMoney(totals.tax_minor, currency)}</td></tr>
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

export function computeTotalsClient(items: LineItem[]) {
  let subtotal_minor = 0, tax_minor = 0;
  for (const it of items) {
    const s = Math.floor(it.qty * it.unit_minor + 0.5);
    subtotal_minor += s;
    tax_minor += Math.floor((s * (it.tax_rate_bp || 0)) / 10_000 + 0.5);
  }
  return { subtotal_minor, tax_minor, total_minor: subtotal_minor + tax_minor };
}
