"use client";

import { TableScroller, TH, THEAD } from "@/components/ui/table-scroller";
import { formatValue, type ReportRow } from "@/lib/reports/chart";
import type { OutputColumn } from "@/lib/reports/compile";
import { cn } from "@/lib/utils";

/** Result grid shared by the builder preview, saved report runs and dashboard cards. */
export function ReportTable({ rows, columns, totals, currency, label, max = 200, className }: { rows: ReportRow[]; columns: OutputColumn[]; totals?: ReportRow | null; currency: string; label: string; max?: number; className?: string }) {
  const cell = (v: ReportRow[string], c: OutputColumn) => {
    if (c.kind === "measure") return formatValue(v, c.format, currency);
    if (c.kind === "date" && typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v)) return v.slice(0, 16).replace("T", " ");
    return v === null || v === undefined || v === "" ? "—" : String(v);
  };
  const shown = rows.slice(0, max);
  return (
    <div className={className}>
      <TableScroller label={label}>
        <table className="w-full text-sm">
          <thead className={THEAD}>
            <tr>
              {columns.map((c) => (
                <th key={c.key} scope="col" className={cn(TH, c.kind === "measure" && "text-right")}>{c.label}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {shown.map((r, i) => (
              <tr key={i}>
                {columns.map((c) => (
                  <td key={c.key} className={cn("max-w-[16rem] truncate px-3 py-2", c.kind === "measure" && "text-right tabular-nums")} title={String(r[c.key] ?? "")}>{cell(r[c.key], c)}</td>
                ))}
              </tr>
            ))}
            {totals && (
              <tr className="bg-secondary/30 font-medium">
                {columns.map((c, i) => (
                  <td key={c.key} className={cn("px-3 py-2", c.kind === "measure" && "text-right tabular-nums")}>{c.kind === "measure" ? cell(totals[c.key] ?? null, c) : i === 0 ? "Total" : ""}</td>
                ))}
              </tr>
            )}
          </tbody>
        </table>
      </TableScroller>
      {rows.length > shown.length && <p className="mt-2 text-xs text-muted-foreground">Showing {shown.length} of {rows.length} rows. Export for the full set.</p>}
    </div>
  );
}
