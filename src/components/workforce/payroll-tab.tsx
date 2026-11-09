"use client";

import { useCallback, useEffect, useState } from "react";
import { Download, Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Empty, ErrorState, Loading } from "@/components/ui/feedback";
import { Field } from "@/components/ui/field";
import { isAbortError, useAbortable } from "@/components/ui/hooks";
import { Input } from "@/components/ui/input";
import { Pill } from "@/components/ui/pill";
import { TableScroller, TH, THEAD } from "@/components/ui/table-scroller";
import type { PayrollExport } from "@/lib/workforce/payroll";
import type { Notice } from "@/app/(app)/workforce/page";
import { jsonFetch, money, todayYmd } from "./shared";

export function PayrollTab({ notify }: { notify: (tone: Notice["tone"], text: string) => void }) {
  const today = todayYmd();
  const [from, setFrom] = useState(`${today.slice(0, 8)}01`);
  const [to, setTo] = useState(today);
  const [data, setData] = useState<PayrollExport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const nextSignal = useAbortable();

  const load = useCallback(async () => {
    const signal = nextSignal();
    setError(null);
    try {
      setData(await jsonFetch<PayrollExport>(`/api/workforce/payroll?from=${from}&to=${to}`, { signal, fallback: "Could not build payroll" }));
    } catch (err) {
      if (isAbortError(err)) return;
      setError(err instanceof Error ? err.message : "Could not build payroll");
    }
  }, [from, to, nextSignal]);

  useEffect(() => {
    void load();
  }, [load]);

  function download() {
    window.location.assign(`/api/workforce/payroll?from=${from}&to=${to}&format=csv`);
    notify("success", "Payroll CSV downloading.");
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex flex-wrap items-end gap-2">
          <Field label="From">
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field label="To">
            <Input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
          </Field>
        </div>
        <Button size="sm" touch onClick={download} disabled={!data || data.lines.length === 0}>
          <Download className="h-4 w-4" /> Export CSV
        </Button>
      </div>
      {error ? (
        <ErrorState message={error} onRetry={() => void load()} />
      ) : !data ? (
        <Loading label="Calculating…" />
      ) : data.lines.length === 0 ? (
        <Empty icon={<Wallet className="h-6 w-6" aria-hidden />} title="Nothing to pay yet" text="Payroll lines appear once staff have scheduled shifts, clock-ins or approved leave in the range." />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Scheduled" value={`${data.totals.scheduled_hours}h`} />
            <Stat label="Attended" value={`${data.totals.attended_hours}h`} />
            <Stat label="Overtime" value={`${data.totals.overtime_hours}h`} />
            <Stat label="Gross" value={Object.entries(data.totals.gross_by_currency).map(([c, m]) => money(m, c)).join(" · ") || "—"} />
          </div>
          <p className="text-xs text-muted-foreground">
            {data.weeks} week{data.weeks === 1 ? "" : "s"} · overtime above contracted hours × weeks at 1.5× · paid leave (vacation, sick) at the hourly rate · times in {data.timezone}.
          </p>
          <TableScroller label="Payroll">
            <table className="w-full text-sm">
              <thead className={THEAD}>
                <tr>
                  <th className={TH}>Who</th>
                  <th className={`${TH} text-right`}>Scheduled</th>
                  <th className={`${TH} text-right`}>Attended</th>
                  <th className={`${TH} text-right`}>Leave</th>
                  <th className={`${TH} text-right`}>Overtime</th>
                  <th className={`${TH} text-right`}>Rate</th>
                  <th className={`${TH} text-right`}>Gross</th>
                </tr>
              </thead>
              <tbody>
                {data.lines.map((l) => (
                  <tr key={l.staff_id} className="border-t border-border">
                    <td className="px-3 py-2">
                      <div className="font-medium">{l.display_name}</div>
                      <div className="text-xs text-muted-foreground">
                        {l.role_title ?? "—"} · {l.employment_type.replace("_", "-")}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{l.scheduled_hours}h</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {l.attended_hours}h{" "}
                      {l.variance_hours !== 0 && (
                        <Pill tone={l.variance_hours > 0 ? "info" : "warning"} className="ml-1">
                          {l.variance_hours > 0 ? "+" : ""}
                          {l.variance_hours}h
                        </Pill>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {l.paid_leave_hours}h{l.unpaid_leave_hours ? <span className="text-xs text-muted-foreground"> (+{l.unpaid_leave_hours}h unpaid)</span> : null}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{l.overtime_hours ? <span className="text-amber-600 dark:text-amber-400">{l.overtime_hours}h</span> : "—"}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{l.hourly_rate_minor ? money(l.hourly_rate_minor, l.currency) : "—"}</td>
                    <td className="px-3 py-2 text-right font-medium tabular-nums">{money(l.gross_minor, l.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroller>
        </>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 truncate text-lg font-semibold tabular-nums">{value}</p>
    </div>
  );
}
