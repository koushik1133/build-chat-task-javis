"use client";

import { useEffect, useId, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { Legend, VIZ_STYLE } from "@/components/insights/charts";
import { formatValue, toChartData, type ChartData, type ReportRow } from "@/lib/reports/chart";
import type { OutputColumn } from "@/lib/reports/compile";
import type { ChartConfig } from "@/lib/reports/spec";

/*
 * Report charts (bar / line / pie / kpi) drawn as inline SVG from aggregated
 * rows. Same conventions as the Insights charts: thin marks, one axis, legend
 * for >= 2 series, hover + keyboard tooltip, a "view as table" fallback, and a
 * fixed categorical hue order validated with the dataviz palette script
 * (slots 1–6 light/dark). Status colours are never used for series.
 */

const EXTRA_STYLE = `
.kh-viz{--viz-4:#8b5cf6;--viz-5:#d6336c;--viz-6:#0e9aa7;}
.dark .kh-viz{--viz-4:#9775f5;--viz-5:#e8457f;--viz-6:#1aa5bb;}
`;
const SERIES_VARS = ["var(--viz-1)", "var(--viz-2)", "var(--viz-3)", "var(--viz-4)", "var(--viz-5)", "var(--viz-6)", "var(--viz-1)", "var(--viz-2)"];
const FONT = 11;

function useContainerWidth(fallback = 640): [React.RefObject<HTMLDivElement>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setWidth(Math.max(260, Math.round(el.clientWidth)));
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}

const labelEvery = (slot: number) => Math.max(1, Math.ceil(56 / Math.max(slot, 1)));

function Tooltip({ x, width, children }: { x: number; width: number; children: React.ReactNode }) {
  const left = Math.min(Math.max(x, 0), width);
  const flip = left > width * 0.6;
  return (
    <div role="status" aria-live="polite" className="pointer-events-none absolute top-1 z-10 max-w-[min(16rem,80%)] rounded-md border border-border bg-card px-2.5 py-1.5 text-xs shadow-md" style={{ left, transform: flip ? "translateX(calc(-100% - 8px))" : "translateX(8px)" }}>
      {children}
    </div>
  );
}

export interface ReportChartProps {
  rows: ReportRow[];
  columns: OutputColumn[];
  chart: ChartConfig;
  currency: string;
  title?: string;
  className?: string;
  /** Compact mode for dashboard cards. */
  compact?: boolean;
}

export function ReportChart(props: ReportChartProps) {
  const data = toChartData(props.rows, props.columns, props.chart);
  if (props.chart.type === "kpi") return <KpiTiles data={data} currency={props.currency} className={props.className} />;
  if (props.chart.type === "pie") return <PieChart data={data} currency={props.currency} title={props.title} className={props.className} compact={props.compact} />;
  if (props.chart.type === "line") return <SeriesChart data={data} currency={props.currency} title={props.title} className={props.className} compact={props.compact} kind="line" />;
  return <SeriesChart data={data} currency={props.currency} title={props.title} className={props.className} compact={props.compact} kind="bar" />;
}

function KpiTiles({ data, currency, className }: { data: ChartData; currency: string; className?: string }) {
  return (
    <div className={cn("grid grid-cols-2 gap-3 lg:grid-cols-4", className)}>
      {data.series.map((s) => (
        <div key={s.key} className="rounded-xl border border-border bg-card p-4">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">{s.label}</p>
          <p className="mt-1 text-xl font-semibold tabular-nums sm:text-2xl">{formatValue(s.values[0], data.format, currency)}</p>
        </div>
      ))}
      {data.series.length === 0 && <p className="text-sm text-muted-foreground">Add a measure to show a KPI.</p>}
    </div>
  );
}

function SeriesChart({ data, currency, title, className, compact, kind }: { data: ChartData; currency: string; title?: string; className?: string; compact?: boolean; kind: "bar" | "line" }) {
  const [ref, width] = useContainerWidth();
  const [hover, setHover] = useState<number | null>(null);
  const id = useId();
  const height = compact ? 180 : 260;
  const pad = { top: 12, right: 12, bottom: 28, left: 52 };
  const n = data.categories.length;
  const innerW = Math.max(10, width - pad.left - pad.right);
  const innerH = height - pad.top - pad.bottom;
  const max = niceMax(Math.max(0, ...data.series.flatMap((s) => s.values.map((v) => v ?? 0))));
  const min = Math.min(0, ...data.series.flatMap((s) => s.values.map((v) => v ?? 0)));
  const range = max - min || 1;
  const y = (v: number) => pad.top + innerH - ((v - min) / range) * innerH;
  const slot = innerW / Math.max(n, 1);
  const every = labelEvery(slot);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => min + t * range);
  const seriesCount = Math.max(1, data.series.length);
  const barW = Math.max(2, (slot - 6) / seriesCount - 2);

  if (n === 0 || data.series.length === 0) return <p className={cn("py-10 text-center text-sm text-muted-foreground", className)}>No data to chart. Add a dimension and a measure.</p>;

  return (
    <div ref={ref} className={cn("kh-viz relative", className)}>
      <style>{VIZ_STYLE + EXTRA_STYLE}</style>
      <svg width={width} height={height} role="img" aria-labelledby={`${id}-t`} className="block" onMouseLeave={() => setHover(null)} onKeyDown={(e) => e.key === "Escape" && setHover(null)}>
        <title id={`${id}-t`}>{title ?? `${kind} chart of ${data.series.map((s) => s.label).join(", ")}`}</title>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.left} x2={width - pad.right} y1={y(t)} y2={y(t)} stroke="var(--viz-grid)" />
            <text x={pad.left - 6} y={y(t) + 4} textAnchor="end" fontSize={FONT} fill="var(--viz-ink)">{formatValue(t, data.format, currency, true)}</text>
          </g>
        ))}
        <line x1={pad.left} x2={width - pad.right} y1={y(0)} y2={y(0)} stroke="var(--viz-line)" strokeOpacity={0.5} />
        {data.categories.map((c, i) =>
          i % every === 0 ? (
            <text key={c + i} x={pad.left + slot * i + slot / 2} y={height - 8} textAnchor="middle" fontSize={FONT} fill="var(--viz-ink)">
              {c.length > 12 ? `${c.slice(0, 11)}…` : c}
            </text>
          ) : null
        )}
        {kind === "bar" &&
          data.series.map((s, si) =>
            s.values.map((v, i) => {
              if (v === null) return null;
              const x = pad.left + slot * i + 3 + si * (barW + 2);
              const top = y(Math.max(v, 0));
              const h = Math.max(1, Math.abs(y(v) - y(0)));
              return <rect key={`${si}-${i}`} x={x} y={top} width={barW} height={h} rx={2} fill={SERIES_VARS[si]} opacity={hover === null || hover === i ? 1 : 0.45} />;
            })
          )}
        {kind === "line" &&
          data.series.map((s, si) => {
            const pts = s.values.map((v, i) => (v === null ? null : `${pad.left + slot * i + slot / 2},${y(v)}`)).filter((p): p is string => Boolean(p));
            return (
              <g key={s.key}>
                <polyline points={pts.join(" ")} fill="none" stroke={SERIES_VARS[si]} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
                {s.values.map((v, i) => (v === null ? null : <circle key={i} cx={pad.left + slot * i + slot / 2} cy={y(v)} r={hover === i ? 4.5 : 3} fill={SERIES_VARS[si]} stroke="var(--background, #fff)" strokeWidth={1.5} />))}
              </g>
            );
          })}
        {data.categories.map((c, i) => (
          <rect key={`hit-${i}`} data-hit="" x={pad.left + slot * i} y={pad.top} width={slot} height={innerH} fill="transparent" tabIndex={0} aria-label={`${c}: ${data.series.map((s) => `${s.label} ${formatValue(s.values[i], data.format, currency)}`).join(", ")}`} onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} onBlur={() => setHover((h) => (h === i ? null : h))} />
        ))}
      </svg>
      {hover !== null && (
        <Tooltip x={pad.left + slot * hover + slot / 2} width={width}>
          <p className="font-medium">{data.categories[hover]}</p>
          {data.series.map((s, si) => (
            <p key={s.key} className="flex items-center gap-1.5 tabular-nums">
              <span className="inline-block h-2 w-2 rounded-sm" style={{ background: SERIES_VARS[si] }} aria-hidden /> {s.label}: {formatValue(s.values[hover], data.format, currency)}
            </p>
          ))}
        </Tooltip>
      )}
      {data.series.length > 1 && <Legend items={data.series.map((s, i) => ({ label: s.label, swatch: SERIES_VARS[i] }))} />}
    </div>
  );
}

function PieChart({ data, currency, title, className, compact }: { data: ChartData; currency: string; title?: string; className?: string; compact?: boolean }) {
  const id = useId();
  const [hover, setHover] = useState<number | null>(null);
  const s = data.series[0];
  if (!s || data.categories.length === 0) return <p className={cn("py-10 text-center text-sm text-muted-foreground", className)}>No data to chart. Add a dimension and a measure.</p>;
  const size = compact ? 160 : 220;
  const r = size / 2 - 6;
  const cx = size / 2;
  const cy = size / 2;
  const vals = s.values.map((v) => Math.max(0, v ?? 0));
  const total = vals.reduce((a, b) => a + b, 0) || 1;
  // Fold slices beyond the 6th into "Other" so hues are never cycled.
  const order = vals.map((v, i) => [v, i] as const).sort((a, b) => b[0] - a[0]);
  const keep = order.slice(0, 6);
  const rest = order.slice(6);
  const slices = keep.map(([v, i]) => ({ label: data.categories[i], v }));
  if (rest.length) slices.push({ label: "Other", v: rest.reduce((a, [v]) => a + v, 0) });
  let acc = 0;
  const arcs = slices.map((sl, i) => {
    const a0 = (acc / total) * Math.PI * 2 - Math.PI / 2;
    acc += sl.v;
    const a1 = (acc / total) * Math.PI * 2 - Math.PI / 2;
    const large = a1 - a0 > Math.PI ? 1 : 0;
    const p0 = [cx + r * Math.cos(a0), cy + r * Math.sin(a0)];
    const p1 = [cx + r * Math.cos(a1), cy + r * Math.sin(a1)];
    const d = sl.v === total ? `M ${cx} ${cy - r} A ${r} ${r} 0 1 1 ${cx - 0.01} ${cy - r} Z` : `M ${cx} ${cy} L ${p0[0]} ${p0[1]} A ${r} ${r} 0 ${large} 1 ${p1[0]} ${p1[1]} Z`;
    return { ...sl, d, color: i === 6 ? "var(--viz-grid)" : SERIES_VARS[i], pct: Math.round((sl.v / total) * 100) };
  });
  return (
    <div className={cn("kh-viz flex flex-col items-center gap-3 sm:flex-row sm:items-start", className)}>
      <style>{VIZ_STYLE + EXTRA_STYLE}</style>
      <svg width={size} height={size} role="img" aria-labelledby={`${id}-t`} className="shrink-0" onMouseLeave={() => setHover(null)}>
        <title id={`${id}-t`}>{title ?? `Share of ${s.label}`}</title>
        {arcs.map((a, i) => (
          <path key={a.label} d={a.d} fill={a.color} stroke="var(--background, #fff)" strokeWidth={2} opacity={hover === null || hover === i ? 1 : 0.5} tabIndex={0} data-hit="" aria-label={`${a.label}: ${formatValue(a.v, data.format, currency)} (${a.pct}%)`} onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} onBlur={() => setHover((h) => (h === i ? null : h))} />
        ))}
      </svg>
      <ul className="w-full min-w-0 space-y-1 text-sm" aria-label="Legend">
        {arcs.map((a, i) => (
          <li key={a.label} className={cn("flex items-center justify-between gap-3 rounded px-1", hover === i && "bg-secondary/50")}>
            <span className="flex min-w-0 items-center gap-2"><span className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: a.color }} aria-hidden /><span className="truncate">{a.label}</span></span>
            <span className="shrink-0 tabular-nums text-muted-foreground">{formatValue(a.v, data.format, currency)} · {a.pct}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
