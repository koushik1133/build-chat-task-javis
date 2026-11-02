"use client";

import { useEffect, useId, useRef, useState } from "react";
import { cn } from "@/lib/utils";

/*
 * Inline-SVG charts for the Insights page. No chart library: thin marks, one
 * axis per chart, a legend for multi-series, direct labels only where they help,
 * and a hover + keyboard-focus tooltip layer. Every chart also ships a data
 * table so nothing is colour-only. The SVG is drawn at the container's pixel
 * width (measured with a ResizeObserver) so text stays 11px on a phone instead
 * of shrinking with a fixed viewBox.
 *
 * Palette: categorical slots 1–3 (blue, orange, aqua) validated with the dataviz
 * palette script for light and dark surfaces; warn is a reserved status colour
 * and is never used for a series. The app toggles `dark` on <html>.
 */

export const VIZ_STYLE = `
.kh-viz{--viz-1:#2a78d6;--viz-1-soft:#2a78d655;--viz-2:#eb6834;--viz-3:#1baf7a;--viz-warn:#c98500;--viz-grid:#00000014;--viz-ink:#52514e;--viz-line:#0b0b0b;--viz-focus:#2a78d6;}
.dark .kh-viz{--viz-1:#3987e5;--viz-1-soft:#3987e566;--viz-2:#d95926;--viz-3:#199e70;--viz-warn:#eda100;--viz-grid:#ffffff1f;--viz-ink:#c3c2b7;--viz-line:#f0efec;--viz-focus:#3987e5;}
.kh-viz [data-hit]{outline:none}
.kh-viz [data-hit]:focus-visible{stroke:var(--viz-focus);stroke-width:2;fill:var(--viz-grid)}
`;

const FONT = 11;

/** Width of the chart's wrapper in CSS pixels, so the SVG can be drawn 1:1. */
function useContainerWidth(fallback = 720): [React.RefObject<HTMLDivElement>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setWidth(Math.max(280, Math.round(el.clientWidth)));
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
  const m = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return m * p;
}

const shortMoney = (minor: number, ccy: string) => {
  const v = minor / 100;
  const abs = Math.abs(v);
  const s = abs >= 1_000_000 ? `${(v / 1_000_000).toFixed(1)}M` : abs >= 1_000 ? `${(v / 1_000).toFixed(abs >= 10_000 ? 0 : 1)}k` : v.toFixed(0);
  return `${ccy} ${s}`;
};
const shortWeek = (iso: string) => {
  const d = new Date(iso + "T00:00:00Z");
  return `${d.getUTCDate()} ${d.toLocaleString(undefined, { month: "short", timeZone: "UTC" })}`;
};
const pct = (v: number) => `${Math.round(v * 100)}%`;

/** Label every n-th slot so x labels (~44px wide) never collide. */
const labelEvery = (slot: number) => Math.max(1, Math.ceil(44 / Math.max(slot, 1)));

export function Legend({ items }: { items: Array<{ label: string; swatch: string; dashed?: boolean }> }) {
  return (
    <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground" aria-label="Legend">
      {items.map((i) => (
        <li key={i.label} className="flex items-center gap-1.5">
          <span className={cn("inline-block h-2.5 w-3 rounded-sm", i.dashed && "border-b-2 border-dashed bg-transparent")} style={i.dashed ? { borderColor: i.swatch } : { background: i.swatch }} aria-hidden />
          {i.label}
        </li>
      ))}
    </ul>
  );
}

/** Floating tooltip for the hovered or focused mark, anchored at the mark's x in pixels. */
function Tooltip({ x, width, children }: { x: number; width: number; children: React.ReactNode }) {
  const left = Math.min(Math.max(x, 0), width);
  const flip = left > width * 0.6;
  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none absolute top-1 z-10 max-w-[min(16rem,80%)] rounded-md border border-border bg-card px-2.5 py-1.5 text-xs shadow-md"
      style={{ left, transform: flip ? "translateX(calc(-100% - 8px))" : "translateX(8px)" }}
    >
      {children}
    </div>
  );
}

/** Toggleable data table so every chart has a non-visual reading. */
function DataTable({ caption, head, rows }: { caption: string; head: string[]; rows: Array<Array<string | number>> }) {
  return (
    <details className="mt-3 text-sm">
      <summary className="inline-flex min-h-11 cursor-pointer items-center rounded-md px-1 text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-0">
        View as table
      </summary>
      <div role="region" aria-label={caption} tabIndex={0} className="mt-2 max-h-72 overflow-auto rounded-lg border border-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <table className="w-full min-w-[28rem] text-xs">
          <caption className="sr-only">{caption}</caption>
          <thead className="bg-secondary/40 text-left uppercase tracking-wide text-muted-foreground">
            <tr>
              {head.map((h, i) => (
                <th key={h} scope="col" className={cn("px-3 py-1.5 font-medium", i > 0 && "text-right")}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((r, i) => (
              <tr key={i}>
                {r.map((c, j) => (
                  <td key={j} className={cn("px-3 py-1.5 tabular-nums", j > 0 && "text-right")}>
                    {c}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

/** Escape clears the hover/focus tooltip. */
function escapeHandler(clear: () => void) {
  return (e: React.KeyboardEvent) => {
    if (e.key === "Escape") clear();
  };
}

/** Invisible per-slot hit target: hover and keyboard focus both open the tooltip. */
function Hit({ x, y, width, height, index, label, setHover }: { x: number; y: number; width: number; height: number; index: number; label: string; setHover: React.Dispatch<React.SetStateAction<number | null>> }) {
  return (
    <rect
      data-hit=""
      x={x}
      y={y}
      width={width}
      height={height}
      fill="transparent"
      rx={2}
      tabIndex={0}
      onMouseEnter={() => setHover(index)}
      onFocus={() => setHover(index)}
      onBlur={() => setHover((h) => (h === index ? null : h))}
      aria-label={label}
    />
  );
}

export interface CashflowPoint {
  weekStart: string;
  inflowConfirmed: number;
  inflowExpected: number;
  outflow: number;
  balanceConfirmed: number;
}

/** Weekly inflow (confirmed + expected) and outflow bars with the confirmed balance as a line. */
export function CashflowChart({ points, currency, className }: { points: CashflowPoint[]; currency: string; className?: string }) {
  const id = useId();
  const [wrap, W] = useContainerWidth();
  const [hover, setHover] = useState<number | null>(null);
  const H = 260;
  const padL = 64;
  const padR = 12;
  const padT = 12;
  const padB = 40;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  const n = Math.max(points.length, 1);
  const slot = innerW / n;
  const barW = Math.max(3, Math.min(18, slot * 0.28));
  const every = labelEvery(slot);

  const maxBar = niceMax(Math.max(...points.map((p) => Math.max(p.inflowConfirmed + p.inflowExpected, p.outflow)), 1));
  const balMin = Math.min(0, ...points.map((p) => p.balanceConfirmed));
  const balMax = Math.max(maxBar, ...points.map((p) => p.balanceConfirmed));
  const yMin = Math.min(0, balMin);
  const yMax = niceMax(balMax);
  const y = (v: number) => padT + innerH - ((v - yMin) / (yMax - yMin || 1)) * innerH;
  const zero = y(0);
  const ticks = [yMin, yMin + (yMax - yMin) / 2, yMax].map((v) => Math.round(v));

  const line = points.map((p, i) => `${i === 0 ? "M" : "L"}${(padL + i * slot + slot / 2).toFixed(1)},${y(p.balanceConfirmed).toFixed(1)}`).join(" ");
  const h = hover !== null ? points[hover] : null;
  const last = points[points.length - 1];
  const summary = points.length
    ? `Weekly cash in, cash out and confirmed balance over ${points.length} weeks from ${shortWeek(points[0].weekStart)}. Ending balance ${shortMoney(last.balanceConfirmed, currency)}.`
    : "Weekly cash flow chart with no data.";

  return (
    <div ref={wrap} className={cn("kh-viz relative min-w-0", className)} onKeyDown={escapeHandler(() => setHover(null))}>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={summary} className="block max-w-full overflow-visible" onMouseLeave={() => setHover(null)}>
        <title id={`${id}-t`}>Weekly cash in, cash out and confirmed balance</title>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={padL} x2={W - padR} y1={y(t)} y2={y(t)} stroke="var(--viz-grid)" strokeWidth={1} />
            <text x={padL - 6} y={y(t) + 4} textAnchor="end" fontSize={FONT} fill="var(--viz-ink)">
              {shortMoney(t, currency)}
            </text>
          </g>
        ))}
        <text x={12} y={padT + innerH / 2} fontSize={FONT} fill="var(--viz-ink)" textAnchor="middle" transform={`rotate(-90 12 ${padT + innerH / 2})`}>
          {currency}
        </text>
        <text x={padL + innerW / 2} y={H - 4} fontSize={FONT} fill="var(--viz-ink)" textAnchor="middle">
          Week starting
        </text>
        <line x1={padL} x2={W - padR} y1={zero} y2={zero} stroke="var(--viz-ink)" strokeWidth={1} opacity={0.5} />
        {points.map((p, i) => {
          const cx = padL + i * slot + slot / 2;
          const inX = cx - barW - 1;
          const outX = cx + 1;
          const confH = zero - y(p.inflowConfirmed);
          const expH = y(p.inflowConfirmed) - y(p.inflowConfirmed + p.inflowExpected);
          const outH = zero - y(p.outflow);
          const active = hover === i;
          return (
            <g key={p.weekStart} opacity={hover === null || active ? 1 : 0.55}>
              <rect x={inX} y={zero - confH} width={barW} height={Math.max(0, confH)} fill="var(--viz-1)" rx={2} />
              {expH > 0 && <rect x={inX} y={zero - confH - expH + 1} width={barW} height={Math.max(0, expH - 1)} fill="var(--viz-1-soft)" stroke="var(--viz-1)" strokeDasharray="2 2" strokeWidth={1} rx={2} />}
              <rect x={outX} y={zero - outH} width={barW} height={Math.max(0, outH)} fill="var(--viz-2)" rx={2} />
              {i % every === 0 && (
                <text x={cx} y={H - padB + 16} textAnchor="middle" fontSize={FONT} fill="var(--viz-ink)">
                  {shortWeek(p.weekStart)}
                </text>
              )}
            </g>
          );
        })}
        <path d={line} fill="none" stroke="var(--viz-line)" strokeWidth={2} strokeLinejoin="round" />
        {points.map((p, i) => (
          <circle key={p.weekStart} cx={padL + i * slot + slot / 2} cy={y(p.balanceConfirmed)} r={hover === i ? 5 : 4} fill="var(--viz-line)" stroke="hsl(var(--card))" strokeWidth={1.5} pointerEvents="none" />
        ))}
        {points.map((p, i) => (
          <Hit
            key={`hit-${p.weekStart}`}
            index={i}
            x={padL + i * slot}
            y={padT}
            width={slot}
            height={innerH}
            setHover={setHover}
            label={`Week of ${shortWeek(p.weekStart)}: in ${shortMoney(p.inflowConfirmed, currency)} confirmed plus ${shortMoney(p.inflowExpected, currency)} expected, out ${shortMoney(p.outflow, currency)}, balance ${shortMoney(p.balanceConfirmed, currency)}`}
          />
        ))}
      </svg>
      {h && hover !== null && (
        <Tooltip x={padL + hover * slot + slot / 2} width={W}>
          <p className="font-medium">Week of {shortWeek(h.weekStart)}</p>
          <p className="tabular-nums">
            In {shortMoney(h.inflowConfirmed, currency)} <span className="text-muted-foreground">+ {shortMoney(h.inflowExpected, currency)} expected</span>
          </p>
          <p className="tabular-nums">Out {shortMoney(h.outflow, currency)}</p>
          <p className="tabular-nums">Balance {shortMoney(h.balanceConfirmed, currency)}</p>
        </Tooltip>
      )}
      <Legend
        items={[
          { label: "Cash in (confirmed)", swatch: "var(--viz-1)" },
          { label: "Cash in (pipeline, weighted)", swatch: "var(--viz-1-soft)" },
          { label: "Cash out", swatch: "var(--viz-2)" },
          { label: "Confirmed balance", swatch: "var(--viz-line)" },
        ]}
      />
      <DataTable
        caption="Weekly cash flow"
        head={["Week", "In (confirmed)", "In (pipeline)", "Out", "Balance"]}
        rows={points.map((p) => [shortWeek(p.weekStart), shortMoney(p.inflowConfirmed, currency), shortMoney(p.inflowExpected, currency), shortMoney(p.outflow, currency), shortMoney(p.balanceConfirmed, currency)])}
      />
    </div>
  );
}

export interface UtilPoint {
  weekStart: string;
  utilisation: number;
  bottleneck: boolean;
  past: boolean;
}

/** Utilisation per week against a target line; over-target weeks use the warning colour and a direct label. */
export function UtilisationChart({ points, target, className }: { points: UtilPoint[]; target: number; className?: string }) {
  const id = useId();
  const [wrap, W] = useContainerWidth();
  const [hover, setHover] = useState<number | null>(null);
  const H = 220;
  const padL = 44;
  const padR = 12;
  const padT = 16;
  const padB = 40;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  const n = Math.max(points.length, 1);
  const slot = innerW / n;
  const barW = Math.max(6, Math.min(28, slot * 0.6));
  const every = labelEvery(slot);
  const maxU = Math.max(1, target, ...points.map((p) => p.utilisation)) * 1.08;
  const y = (v: number) => padT + innerH - (v / maxU) * innerH;
  const h = hover !== null ? points[hover] : null;
  const over = points.filter((p) => p.bottleneck).length;
  const summary = points.length
    ? `Utilisation per week for ${points.length} weeks against a ${pct(target)} target. ${over === 0 ? "No week is over target." : `${over} week${over === 1 ? " is" : "s are"} over target.`}`
    : "Utilisation chart with no data.";

  return (
    <div ref={wrap} className={cn("kh-viz relative min-w-0", className)} onKeyDown={escapeHandler(() => setHover(null))}>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={summary} className="block max-w-full overflow-visible" onMouseLeave={() => setHover(null)}>
        <title id={`${id}-t`}>Utilisation per week against the target</title>
        {[0, 0.5, 1].map((t) => (
          <g key={t}>
            <line x1={padL} x2={W - padR} y1={y(t)} y2={y(t)} stroke="var(--viz-grid)" strokeWidth={1} />
            <text x={padL - 6} y={y(t) + 4} textAnchor="end" fontSize={FONT} fill="var(--viz-ink)">
              {pct(t)}
            </text>
          </g>
        ))}
        <text x={padL + innerW / 2} y={H - 4} fontSize={FONT} fill="var(--viz-ink)" textAnchor="middle">
          Week starting
        </text>
        <line x1={padL} x2={W - padR} y1={y(target)} y2={y(target)} stroke="var(--viz-warn)" strokeDasharray="4 3" strokeWidth={1.5} />
        <text x={W - padR} y={y(target) - 4} textAnchor="end" fontSize={FONT} fill="var(--viz-ink)">
          Target {pct(target)}
        </text>
        {points.map((p, i) => {
          const cx = padL + i * slot + slot / 2;
          const bh = y(0) - y(p.utilisation);
          return (
            <g key={p.weekStart} opacity={hover === null || hover === i ? 1 : 0.55}>
              <rect x={cx - barW / 2} y={y(p.utilisation)} width={barW} height={Math.max(0, bh)} rx={3} fill={p.bottleneck ? "var(--viz-warn)" : "var(--viz-1)"} opacity={p.past ? 0.45 : 1} />
              {p.bottleneck && (
                <text x={cx} y={y(p.utilisation) - 4} textAnchor="middle" fontSize={FONT} fill="var(--viz-ink)">
                  {pct(p.utilisation)}
                </text>
              )}
              {i % every === 0 && (
                <text x={cx} y={H - padB + 16} textAnchor="middle" fontSize={FONT} fill="var(--viz-ink)">
                  {shortWeek(p.weekStart)}
                </text>
              )}
            </g>
          );
        })}
        {points.map((p, i) => (
          <Hit
            key={`hit-${p.weekStart}`}
            index={i}
            x={padL + i * slot}
            y={padT}
            width={slot}
            height={innerH}
            setHover={setHover}
            label={`Week of ${shortWeek(p.weekStart)}${p.past ? " (past)" : ""}: ${pct(p.utilisation)} utilised${p.bottleneck ? ", over target" : ""}`}
          />
        ))}
      </svg>
      {h && hover !== null && (
        <Tooltip x={padL + hover * slot + slot / 2} width={W}>
          <p className="font-medium">
            Week of {shortWeek(h.weekStart)}
            {h.past ? " · past" : ""}
          </p>
          <p className="tabular-nums">
            {pct(h.utilisation)} utilised{h.bottleneck ? " — over target" : ""}
          </p>
        </Tooltip>
      )}
      <Legend
        items={[
          { label: "Within target", swatch: "var(--viz-1)" },
          { label: "Over target (bottleneck)", swatch: "var(--viz-warn)" },
          { label: "Target", swatch: "var(--viz-warn)", dashed: true },
        ]}
      />
      <DataTable caption="Utilisation by week" head={["Week", "Utilisation", "Status"]} rows={points.map((p) => [shortWeek(p.weekStart) + (p.past ? " (past)" : ""), pct(p.utilisation), p.bottleneck ? "Over target" : "Within target"])} />
    </div>
  );
}

export interface BandPoint {
  min_minor: number;
  max_minor: number;
  won: number;
  lost: number;
  winRate: number;
}

/** Win rate per price band as horizontal bars, with the current and suggested price marked. */
export function BandChart({ bands, current, suggested, currency, className }: { bands: BandPoint[]; current: number; suggested: number | null; currency: string; className?: string }) {
  const id = useId();
  const [wrap, W] = useContainerWidth();
  const [hover, setHover] = useState<number | null>(null);
  const rowH = 32;
  const narrow = W < 480;
  const padL = narrow ? 104 : 150;
  const padR = narrow ? 56 : 92;
  const padT = 4;
  const H = bands.length * rowH + padT + 20;
  const innerW = Math.max(40, W - padL - padR);
  const inBand = (b: BandPoint, v: number | null) => v !== null && v >= b.min_minor && v <= b.max_minor;
  const fmt = (m: number) => `${currency} ${(m / 100).toFixed(0)}`;
  const marksFor = (b: BandPoint) => [inBand(b, current) ? "now" : null, inBand(b, suggested) ? "suggested" : null].filter(Boolean).join(" · ");
  const h = hover !== null ? bands[hover] : null;
  const best = bands.reduce<BandPoint | null>((acc, b) => (acc === null || b.winRate > acc.winRate ? b : acc), null);
  const summary = best ? `Win rate by price band across ${bands.length} bands. Highest win rate ${pct(best.winRate)} at ${fmt(best.min_minor)} to ${fmt(best.max_minor)}.` : "Win rate chart with no bands.";

  return (
    <div ref={wrap} className={cn("kh-viz relative min-w-0", className)} onKeyDown={escapeHandler(() => setHover(null))}>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={summary} className="block max-w-full overflow-visible" onMouseLeave={() => setHover(null)}>
        <title id={`${id}-t`}>Win rate by price band</title>
        {[0, 0.5, 1].map((t) => (
          <g key={t}>
            <line x1={padL + innerW * t} x2={padL + innerW * t} y1={padT} y2={H - 20} stroke="var(--viz-grid)" strokeWidth={1} />
            <text x={padL + innerW * t} y={H - 6} textAnchor="middle" fontSize={FONT} fill="var(--viz-ink)">
              {pct(t)}
            </text>
          </g>
        ))}
        {bands.map((b, i) => {
          const yy = padT + i * rowH;
          const w = innerW * b.winRate;
          const marks = marksFor(b);
          return (
            <g key={i} opacity={hover === null || hover === i ? 1 : 0.55}>
              <text x={padL - 8} y={yy + rowH / 2 + 4} textAnchor="end" fontSize={FONT} fill="var(--viz-ink)">
                {fmt(b.min_minor)}–{fmt(b.max_minor)}
              </text>
              <rect x={padL} y={yy + 7} width={innerW} height={rowH - 14} fill="var(--viz-grid)" rx={3} />
              <rect x={padL} y={yy + 7} width={Math.max(2, w)} height={rowH - 14} fill={inBand(b, suggested) ? "var(--viz-3)" : "var(--viz-1)"} rx={3} />
              <text x={padL + Math.max(2, w) + 6} y={yy + rowH / 2 + 4} fontSize={FONT} fill="var(--viz-ink)">
                {pct(b.winRate)}
                {!narrow && (
                  <tspan opacity={0.7}>
                    {" "}
                    ({b.won}/{b.won + b.lost})
                  </tspan>
                )}
              </text>
              {marks && (
                <text x={W - 2} y={yy + rowH / 2 + 4} textAnchor="end" fontSize={FONT} fill="var(--viz-ink)" fontWeight={600}>
                  {marks}
                </text>
              )}
            </g>
          );
        })}
        {bands.map((b, i) => (
          <Hit
            key={`hit-${i}`}
            index={i}
            x={0}
            y={padT + i * rowH}
            width={W}
            height={rowH}
            setHover={setHover}
            label={`${fmt(b.min_minor)} to ${fmt(b.max_minor)}: ${pct(b.winRate)} win rate, ${b.won} won, ${b.lost} lost${marksFor(b) ? `, ${marksFor(b)}` : ""}`}
          />
        ))}
      </svg>
      {h && hover !== null && (
        <Tooltip x={padL + innerW * h.winRate} width={W}>
          <p className="font-medium">
            {fmt(h.min_minor)}–{fmt(h.max_minor)}
          </p>
          <p className="tabular-nums">
            {pct(h.winRate)} win rate · {h.won} won, {h.lost} lost
          </p>
          {marksFor(h) && <p className="text-muted-foreground">{marksFor(h)}</p>}
        </Tooltip>
      )}
      <Legend items={[{ label: "Win rate", swatch: "var(--viz-1)" }, { label: "Suggested band", swatch: "var(--viz-3)" }]} />
      <DataTable caption="Win rate by price band" head={["Band", "Win rate", "Won", "Lost", "Marks"]} rows={bands.map((b) => [`${fmt(b.min_minor)}–${fmt(b.max_minor)}`, pct(b.winRate), b.won, b.lost, marksFor(b) || "—"])} />
    </div>
  );
}
