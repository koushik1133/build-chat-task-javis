"use client";

import { useMemo } from "react";
import { TableScroller, TH, THEAD } from "@/components/ui/table-scroller";
import { Empty } from "@/components/ui/feedback";
import { daysBetween, weekBuckets, type TimelineData } from "@/lib/projects/pure";
import { fmtDay } from "./shared";
import { cn } from "@/lib/utils";

/**
 * Gantt-lite: milestones as diamonds, tasks as bars from start to due, a
 * today line, week columns. Scrolls horizontally inside a TableScroller-like
 * region; an accessible table lists the same data below for screen readers.
 */

const DAY_PX = 28;
const ROW_PX = 32;
const LABEL_W = 180;
const HEADER_H = 40;

export function Gantt({ data, className }: { data: TimelineData; className?: string }) {
  const weeks = useMemo(() => weekBuckets(data.range), [data.range]);
  const width = LABEL_W + data.range.days * DAY_PX;
  const height = HEADER_H + Math.max(1, data.items.length) * ROW_PX + 8;
  const x = (ymd: string) => LABEL_W + daysBetween(data.range.start, ymd) * DAY_PX;
  const todayX = x(data.today) + DAY_PX / 2;

  if (data.items.length === 0) {
    return <Empty title="Nothing to plot yet" text="Add milestones with due dates or tasks with due dates and they appear here." className={className} />;
  }

  return (
    <div className={cn("space-y-4", className)}>
      <TableScroller label={`Timeline for ${data.project.name}`}>
        <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Gantt chart: ${data.items.length} items from ${fmtDay(data.range.start)} to ${fmtDay(data.range.end)}`} className="block text-[11px] select-none">
          {/* week columns */}
          {weeks.map((w, i) => {
            const wx = x(w.start);
            return (
              <g key={w.start}>
                <rect x={wx} y={0} width={w.days * DAY_PX} height={height} className={i % 2 === 0 ? "fill-secondary/30" : "fill-transparent"} />
                <line x1={wx} y1={0} x2={wx} y2={height} className="stroke-border" strokeWidth={1} />
                <text x={wx + 6} y={16} className="fill-muted-foreground font-medium">
                  {w.label}
                </text>
              </g>
            );
          })}
          <line x1={0} y1={HEADER_H - 0.5} x2={width} y2={HEADER_H - 0.5} className="stroke-border" />
          {/* rows */}
          {data.items.map((it, i) => {
            const y = HEADER_H + i * ROW_PX;
            const cy = y + ROW_PX / 2;
            const barClass = it.done ? "fill-emerald-500/70" : it.overdue ? "fill-red-500/80" : it.kind === "milestone" ? "fill-violet-500" : "fill-primary/80";
            return (
              <g key={`${it.kind}:${it.id}`}>
                <line x1={LABEL_W} y1={y + ROW_PX} x2={width} y2={y + ROW_PX} className="stroke-border/60" />
                <text x={8} y={cy + 4} className={cn("fill-foreground", it.done && "fill-muted-foreground line-through")}>
                  <title>{it.label}</title>
                  {it.label.length > 26 ? `${it.label.slice(0, 25)}…` : it.label}
                </text>
                {it.kind === "milestone" ? (
                  <g transform={`translate(${x(it.start) + DAY_PX / 2} ${cy})`}>
                    <title>{`${it.label} — ${fmtDay(it.start)}${it.done ? " (done)" : it.overdue ? " (overdue)" : ""}`}</title>
                    <polygon points="0,-9 9,0 0,9 -9,0" className={barClass} />
                  </g>
                ) : (
                  <g>
                    <title>{`${it.label}: ${fmtDay(it.start)} → ${fmtDay(it.end)}${it.done ? " (done)" : it.overdue ? " (overdue)" : ""}`}</title>
                    <rect x={x(it.start) + 2} y={cy - 8} width={Math.max(DAY_PX - 4, (daysBetween(it.start, it.end) + 1) * DAY_PX - 4)} height={16} rx={4} className={barClass} />
                  </g>
                )}
              </g>
            );
          })}
          {/* today */}
          <line x1={todayX} y1={HEADER_H - 6} x2={todayX} y2={height} className="stroke-amber-500" strokeWidth={2} strokeDasharray="4 3" />
          <text x={todayX + 4} y={HEADER_H - 10} className="fill-amber-600 font-semibold dark:fill-amber-400">
            Today
          </text>
          <rect x={0} y={0} width={LABEL_W} height={height} className="fill-card" opacity={0} />
        </svg>
      </TableScroller>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rotate-45 bg-violet-500" aria-hidden /> Milestone</span>
        <span className="inline-flex items-center gap-1.5"><span className="inline-block h-2.5 w-4 rounded bg-primary/80" aria-hidden /> Task</span>
        <span className="inline-flex items-center gap-1.5"><span className="inline-block h-2.5 w-4 rounded bg-red-500/80" aria-hidden /> Overdue</span>
        <span className="inline-flex items-center gap-1.5"><span className="inline-block h-2.5 w-4 rounded bg-emerald-500/70" aria-hidden /> Done</span>
      </div>
      <details className="rounded-lg border border-border">
        <summary className="cursor-pointer px-3 py-2 text-sm font-medium">Timeline as a table</summary>
        <TableScroller label="Timeline items">
          <table className="w-full min-w-[520px] text-sm">
            <thead className={THEAD}>
              <tr>
                <th className={TH}>Item</th>
                <th className={TH}>Type</th>
                <th className={TH}>Start</th>
                <th className={TH}>Due</th>
                <th className={TH}>State</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((it) => (
                <tr key={`${it.kind}:${it.id}`} className="border-t border-border">
                  <td className="px-3 py-2">{it.label}</td>
                  <td className="px-3 py-2 capitalize">{it.kind}</td>
                  <td className="px-3 py-2 tabular-nums">{fmtDay(it.start)}</td>
                  <td className="px-3 py-2 tabular-nums">{fmtDay(it.end)}</td>
                  <td className="px-3 py-2">{it.done ? "Done" : it.overdue ? "Overdue" : "Open"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroller>
      </details>
    </div>
  );
}
