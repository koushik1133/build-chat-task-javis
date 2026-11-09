"use client";

import { useMemo } from "react";
import { AlertCircle, CheckCircle2, Diamond } from "lucide-react";
import { TableScroller, TH, THEAD } from "@/components/ui/table-scroller";
import { Empty } from "@/components/ui/feedback";
import { Pill, type Tone } from "@/components/ui/pill";
import { daysBetween, weekBuckets, type TimelineData, type TimelineItem } from "@/lib/projects/pure";
import { fmtDay } from "./shared";
import { cn } from "@/lib/utils";

/*
 * Project timeline (Gantt-lite).
 *
 *  - md and up: an SVG with week columns, milestones as diamonds, tasks as thin
 *    bars and a dashed "today" rule, inside a bounded, labelled scroll region so
 *    the page never widens. The SVG is aria-hidden because the same data is
 *    read out through the summary and the table below it.
 *  - under md: a single-column stacked list, one row per item, with dates and
 *    a state pill — nothing scrolls sideways on phones.
 *  - always: an sr-only summary ("12 items from … to …; 2 overdue") plus a
 *    collapsible table of every item for screen readers and keyboard users.
 *
 * State is never colour-alone: bars carry a glyph, the list and table spell it
 * out, and text uses text tokens rather than series colours.
 */

const DAY_PX = 26;
const ROW_PX = 32;
const LABEL_W = 184;
const HEADER_H = 40;
const BAR_H = 12;

type ItemState = "done" | "overdue" | "open";
const stateOf = (it: Pick<TimelineItem, "done" | "overdue">): ItemState => (it.done ? "done" : it.overdue ? "overdue" : "open");
const STATE_LABEL: Record<ItemState, string> = { done: "Done", overdue: "Overdue", open: "Open" };
const STATE_TONE: Record<ItemState, Tone> = { done: "success", overdue: "danger", open: "neutral" };
const KIND_LABEL: Record<TimelineItem["kind"], string> = { milestone: "Milestone", task: "Task" };

function barFill(it: TimelineItem): string {
  const s = stateOf(it);
  if (s === "done") return "fill-emerald-500/70";
  if (s === "overdue") return "fill-red-500/80";
  return it.kind === "milestone" ? "fill-violet-500" : "fill-primary/80";
}

function StateIcon({ state }: { state: ItemState }) {
  if (state === "done") return <CheckCircle2 className="h-3 w-3" aria-hidden />;
  if (state === "overdue") return <AlertCircle className="h-3 w-3" aria-hidden />;
  return null;
}

export function Gantt({ data, className }: { data: TimelineData; className?: string }) {
  const weeks = useMemo(() => weekBuckets(data.range), [data.range]);
  const width = LABEL_W + data.range.days * DAY_PX;
  const height = HEADER_H + Math.max(1, data.items.length) * ROW_PX + 8;
  const x = (ymd: string) => LABEL_W + daysBetween(data.range.start, ymd) * DAY_PX;
  const todayX = x(data.today) + DAY_PX / 2;
  const todayInRange = data.today >= data.range.start && data.today <= data.range.end;

  const counts = useMemo(() => {
    let overdue = 0;
    let done = 0;
    let milestones = 0;
    for (const it of data.items) {
      if (it.kind === "milestone") milestones++;
      if (it.done) done++;
      else if (it.overdue) overdue++;
    }
    return { overdue, done, milestones, tasks: data.items.length - milestones };
  }, [data.items]);

  if (data.items.length === 0) {
    return <Empty title="Nothing to plot yet" text="Give milestones or tasks a due date and they appear here." className={className} />;
  }

  const summary = `${data.items.length} items (${counts.tasks} tasks, ${counts.milestones} milestones) from ${fmtDay(data.range.start)} to ${fmtDay(data.range.end)}; ${counts.done} done, ${counts.overdue} overdue.`;

  return (
    <div className={cn("space-y-4", className)}>
      <p className="sr-only">{summary}</p>

      {/* Phones: stacked single-column list */}
      <ul className="divide-y divide-border rounded-xl border border-border bg-card md:hidden" aria-label="Timeline items">
        {data.items.map((it) => {
          const state = stateOf(it);
          return (
            <li key={`${it.kind}:${it.id}`} className="flex items-start gap-3 px-3 py-3">
              <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center text-muted-foreground" aria-hidden>
                {it.kind === "milestone" ? <Diamond className="h-4 w-4" /> : <span className="h-2 w-4 rounded-full bg-primary/80" />}
              </span>
              <div className="min-w-0 flex-1">
                <p className={cn("break-words text-sm font-medium", state === "done" && "text-muted-foreground line-through")}>{it.label}</p>
                <p className="mt-0.5 text-xs text-muted-foreground tabular-nums">
                  {KIND_LABEL[it.kind]} · {it.kind === "milestone" || it.start === it.end ? fmtDay(it.start) : `${fmtDay(it.start)} – ${fmtDay(it.end)}`}
                </p>
              </div>
              <Pill tone={STATE_TONE[state]} className="shrink-0">
                <StateIcon state={state} />
                {STATE_LABEL[state]}
              </Pill>
            </li>
          );
        })}
      </ul>

      {/* md and up: the chart in a bounded scroll region */}
      <div className="hidden md:block">
        <TableScroller label={`Timeline chart for ${data.project.name}`}>
          <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden className="block select-none text-[11px]">
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
            {data.items.map((it, i) => {
              const y = HEADER_H + i * ROW_PX;
              const cy = y + ROW_PX / 2;
              const state = stateOf(it);
              const fill = barFill(it);
              const glyph = state === "done" ? "✓" : state === "overdue" ? "!" : "";
              const barX = x(it.start) + 1;
              const barW = Math.max(DAY_PX - 2, (daysBetween(it.start, it.end) + 1) * DAY_PX - 2);
              return (
                <g key={`${it.kind}:${it.id}`}>
                  <line x1={LABEL_W} y1={y + ROW_PX} x2={width} y2={y + ROW_PX} className="stroke-border/60" />
                  <text x={8} y={cy + 4} className={cn("fill-foreground", state === "done" && "fill-muted-foreground")}>
                    <title>{it.label}</title>
                    {it.label.length > 24 ? `${it.label.slice(0, 23)}…` : it.label}
                  </text>
                  {glyph && (
                    <text x={LABEL_W - 14} y={cy + 4} className={cn("font-semibold", state === "done" ? "fill-emerald-700 dark:fill-emerald-300" : "fill-red-700 dark:fill-red-300")}>
                      {glyph}
                    </text>
                  )}
                  {it.kind === "milestone" ? (
                    <g transform={`translate(${x(it.start) + DAY_PX / 2} ${cy})`}>
                      <title>{`${it.label} — ${fmtDay(it.start)} (${STATE_LABEL[state]})`}</title>
                      <polygon points="0,-8 8,0 0,8 -8,0" className={fill} />
                    </g>
                  ) : (
                    <g>
                      <title>{`${it.label}: ${fmtDay(it.start)} → ${fmtDay(it.end)} (${STATE_LABEL[state]})`}</title>
                      <rect x={barX} y={cy - BAR_H / 2} width={barW} height={BAR_H} rx={4} className={fill} />
                    </g>
                  )}
                </g>
              );
            })}
            {todayInRange && (
              <>
                <line x1={todayX} y1={HEADER_H - 6} x2={todayX} y2={height} className="stroke-amber-500" strokeWidth={2} strokeDasharray="4 3" />
                <text x={todayX + 4} y={HEADER_H - 10} className="fill-muted-foreground font-semibold">
                  Today
                </text>
              </>
            )}
          </svg>
        </TableScroller>
        <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground" aria-label="Legend">
          <li className="inline-flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-2.5 rotate-45 bg-violet-500" aria-hidden /> Milestone
          </li>
          <li className="inline-flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-4 rounded-full bg-primary/80" aria-hidden /> Task
          </li>
          <li className="inline-flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-4 rounded-full bg-red-500/80" aria-hidden /> Overdue (!)
          </li>
          <li className="inline-flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-4 rounded-full bg-emerald-500/70" aria-hidden /> Done (✓)
          </li>
          <li className="inline-flex items-center gap-1.5">
            <span className="inline-block h-3 border-l-2 border-dashed border-amber-500" aria-hidden /> Today
          </li>
        </ul>
      </div>

      <details className="hidden rounded-lg border border-border md:block">
        <summary className="cursor-pointer rounded-lg px-3 py-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Timeline as a table</summary>
        <div className="p-2">
          <TableScroller label="Timeline items">
            <table className="w-full min-w-[520px] text-sm">
              <caption className="sr-only">{summary}</caption>
              <thead className={THEAD}>
                <tr>
                  <th scope="col" className={TH}>
                    Item
                  </th>
                  <th scope="col" className={TH}>
                    Type
                  </th>
                  <th scope="col" className={TH}>
                    Start
                  </th>
                  <th scope="col" className={TH}>
                    Due
                  </th>
                  <th scope="col" className={TH}>
                    State
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((it) => {
                  const state = stateOf(it);
                  return (
                    <tr key={`${it.kind}:${it.id}`} className="border-t border-border">
                      <td className="px-3 py-2 [overflow-wrap:anywhere]">{it.label}</td>
                      <td className="px-3 py-2">{KIND_LABEL[it.kind]}</td>
                      <td className="px-3 py-2 tabular-nums">{fmtDay(it.start)}</td>
                      <td className="px-3 py-2 tabular-nums">{fmtDay(it.end)}</td>
                      <td className="px-3 py-2">
                        <Pill tone={STATE_TONE[state]}>
                          <StateIcon state={state} />
                          {STATE_LABEL[state]}
                        </Pill>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </TableScroller>
        </div>
      </details>
    </div>
  );
}
