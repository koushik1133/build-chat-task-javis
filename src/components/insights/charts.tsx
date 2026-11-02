"use client";

import { useId, useState } from "react";
import { cn } from "@/lib/utils";

/*
 * Inline-SVG charts for the Insights page. No chart library: thin marks, one
 * axis, a legend for multi-series, direct labels only where they help, and a
 * hover layer. Colours are CSS variables so light/dark swap in one place; the
 * app toggles `dark` on <html>.
 */

export const VIZ_STYLE = `
.kh-viz{--viz-1:#2a78d6;--viz-1-soft:#2a78d655;--viz-2:#eb6834;--viz-3:#1baf7a;--viz-warn:#c98500;--viz-bad:#e34948;--viz-grid:#00000014;--viz-ink:#52514e;--viz-line:#0b0b0b;}
:root.dark .kh-viz{--viz-1:#3987e5;--viz-1-soft:#3987e566;--viz-2:#d95926;--viz-3:#199e70;--viz-warn:#eda100;--viz-bad:#e66767;--viz-grid:#ffffff1f;--viz-ink:#c3c2b7;--viz-line:#f0efec;}
`;

export interface CashflowPoint {
  weekStart: string;
  inflowConfirmed: number;
  inflowExpected: number;
  outflow: number;
  balanceConfirmed: number;
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

/** Weekly inflow (confirmed + expected) and outflow bars with the confirmed balance as a line. */
export function CashflowChart({ points, currency, className }: { points: CashflowPoint[]; currency: string; className?: string }) {
  const id = useId();
  const [hover, setHover] = useState<number | null>(null);
  const W = 720;
  const H = 260;
  const padL = 56;
  const padR = 12;
  const padT = 12;
  const padB = 34;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  const n = Math.max(points.length, 1);
  const slot = innerW / n;
  const barW = Math.max(4, Math.min(18, slot * 0.28));

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

  return (
    <div className={cn("kh-viz relative", className)}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-labelledby={`${id}-t`} className="h-auto w-full overflow-visible" onMouseLeave={() => setHover(null)}>
        <title id={`${id}-t`}>Weekly cash in, cash out and confirmed balance</title>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={padL} x2={W - padR} y1={y(t)} y2={y(t)} stroke="var(--viz-grid)" strokeWidth={1} />
            <text x={padL - 6} y={y(t) + 3} textAnchor="end" fontSize={10} fill="var(--viz-ink)">{shortMoney(t, currency)}</text>
          </g>
        ))}
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
              {(i % Math.ceil(n / 8) === 0 || n <= 8) && (
                <text x={cx} y={H - padB + 14} textAnchor="middle" fontSize={10} fill="var(--viz-ink)">{shortWeek(p.weekStart)}</text>
              )}
              <rect x={padL + i * slot} y={padT} width={slot} height={innerH} fill="transparent" onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} tabIndex={0} aria-label={`${shortWeek(p.weekStart)}: in ${shortMoney(p.inflowConfirmed, currency)} confirmed plus ${shortMoney(p.inflowExpected, currency)} expected, out ${shortMoney(p.outflow, currency)}, balance ${shortMoney(p.balanceConfirmed, currency)}`} />
            </g>
          );
        })}
        <path d={line} fill="none" stroke="var(--viz-line)" strokeWidth={2} strokeLinejoin="round" />
        {points.map((p, i) => (
          <circle key={p.weekStart} cx={padL + i * slot + slot / 2} cy={y(p.balanceConfirmed)} r={hover === i ? 4.5 : 3} fill="var(--viz-line)" stroke="var(--card, #fff)" strokeWidth={1.5} pointerEvents="none" />
        ))}
      </svg>
      {h && hover !== null && (
        <div role="status" className="pointer-events-none absolute top-1 rounded-md border border-border bg-card px-2.5 py-1.5 text-xs shadow-md" style={{ left: `${Math.min(78, Math.max(2, ((padL + hover * slot + slot / 2) / W) * 100))}%` }}>
          <p className="font-medium">Week of {shortWeek(h.weekStart)}</p>
          <p className="tabular-nums">In {shortMoney(h.inflowConfirmed, currency)} <span className="text-muted-foreground">+ {shortMoney(h.inflowExpected, currency)} expected</span></p>
          <p className="tabular-nums">Out {shortMoney(h.outflow, currency)}</p>
          <p className="tabular-nums">Balance {shortMoney(h.balanceConfirmed, currency)}</p>
        </div>
      )}
      <Legend items={[{ label: "Cash in (confirmed)", swatch: "var(--viz-1)" }, { label: "Cash in (pipeline, weighted)", swatch: "var(--viz-1-soft)" }, { label: "Cash out", swatch: "var(--viz-2)" }, { label: "Confirmed balance", swatch: "var(--viz-line)" }]} />
    </div>
  );
}

export interface UtilPoint {
  weekStart: string;
  utilisation: number;
  bottleneck: boolean;
  past: boolean;
}

/** Utilisation per week against a target line; over-target weeks use the warning colour. */
export function UtilisationChart({ points, target, className }: { points: UtilPoint[]; target: number; className?: string }) {
  const id = useId();
  const [hover, setHover] = useState<number | null>(null);
  const W = 720;
  const H = 220;
  const padL = 40;
  const padR = 12;
  const padT = 12;
  const padB = 34;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  const n = Math.max(points.length, 1);
  const slot = innerW / n;
  const barW = Math.max(6, Math.min(28, slot * 0.6));
  const maxU = Math.max(1, ...points.map((p) => p.utilisation)) * 1.05;
  const y = (v: number) => padT + innerH - (v / maxU) * innerH;
  const h = hover !== null ? points[hover] : null;

  return (
    <div className={cn("kh-viz relative", className)}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-labelledby={`${id}-t`} className="h-auto w-full overflow-visible" onMouseLeave={() => setHover(null)}>
        <title id={`${id}-t`}>Utilisation per week against the target</title>
        {[0, 0.5, 1].map((t) => (
          <g key={t}>
            <line x1={padL} x2={W - padR} y1={y(t)} y2={y(t)} stroke="var(--viz-grid)" strokeWidth={1} />
            <text x={padL - 6} y={y(t) + 3} textAnchor="end" fontSize={10} fill="var(--viz-ink)">{Math.round(t * 100)}%</text>
          </g>
        ))}
        <line x1={padL} x2={W - padR} y1={y(target)} y2={y(target)} stroke="var(--viz-warn)" strokeDasharray="4 3" strokeWidth={1.5} />
        <text x={W - padR} y={y(target) - 4} textAnchor="end" fontSize={10} fill="var(--viz-ink)">target {Math.round(target * 100)}%</text>
        {points.map((p, i) => {
          const cx = padL + i * slot + slot / 2;
          const bh = y(0) - y(p.utilisation);
          return (
            <g key={p.weekStart} opacity={hover === null || hover === i ? 1 : 0.55}>
              <rect x={cx - barW / 2} y={y(p.utilisation)} width={barW} height={Math.max(0, bh)} rx={3} fill={p.bottleneck ? "var(--viz-warn)" : "var(--viz-1)"} opacity={p.past ? 0.45 : 1} />
              {p.bottleneck && <text x={cx} y={y(p.utilisation) - 4} textAnchor="middle" fontSize={10} fill="var(--viz-ink)">{Math.round(p.utilisation * 100)}%</text>}
              {(i % Math.ceil(n / 8) === 0 || n <= 8) && <text x={cx} y={H - padB + 14} textAnchor="middle" fontSize={10} fill="var(--viz-ink)">{shortWeek(p.weekStart)}</text>}
              <rect x={padL + i * slot} y={padT} width={slot} height={innerH} fill="transparent" onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} tabIndex={0} aria-label={`${shortWeek(p.weekStart)}${p.past ? " (past)" : ""}: ${Math.round(p.utilisation * 100)}% utilised${p.bottleneck ? ", over target" : ""}`} />
            </g>
          );
        })}
      </svg>
      {h && hover !== null && (
        <div role="status" className="pointer-events-none absolute top-1 rounded-md border border-border bg-card px-2.5 py-1.5 text-xs shadow-md" style={{ left: `${Math.min(78, Math.max(2, ((padL + hover * slot + slot / 2) / W) * 100))}%` }}>
          <p className="font-medium">Week of {shortWeek(h.weekStart)}{h.past ? " · past" : ""}</p>
          <p className="tabular-nums">{Math.round(h.utilisation * 100)}% utilised{h.bottleneck ? " — over target" : ""}</p>
        </div>
      )}
      <Legend items={[{ label: "Within target", swatch: "var(--viz-1)" }, { label: "Over target (bottleneck)", swatch: "var(--viz-warn)" }, { label: "Target", swatch: "var(--viz-warn)", dashed: true }]} />
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
  const rowH = 30;
  const W = 720;
  const padL = 150;
  const padR = 60;
  const H = bands.length * rowH + 8;
  const innerW = W - padL - padR;
  const inBand = (b: BandPoint, v: number | null) => v !== null && v >= b.min_minor && v <= b.max_minor;
  const fmt = (m: number) => `${currency} ${(m / 100).toFixed(0)}`;
  return (
    <div className={cn("kh-viz", className)}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-labelledby={`${id}-t`} className="h-auto w-full overflow-visible">
        <title id={`${id}-t`}>Win rate by price band</title>
        {bands.map((b, i) => {
          const yy = 4 + i * rowH;
          const w = innerW * b.winRate;
          const marks = [inBand(b, current) ? "now" : null, inBand(b, suggested) ? "suggested" : null].filter(Boolean).join(" · ");
          return (
            <g key={i}>
              <text x={padL - 8} y={yy + rowH / 2 + 4} textAnchor="end" fontSize={11} fill="var(--viz-ink)">{fmt(b.min_minor)}–{fmt(b.max_minor)}</text>
              <rect x={padL} y={yy + 6} width={innerW} height={rowH - 12} fill="var(--viz-grid)" rx={3} />
              <rect x={padL} y={yy + 6} width={Math.max(2, w)} height={rowH - 12} fill={inBand(b, suggested) ? "var(--viz-3)" : "var(--viz-1)"} rx={3}>
                <title>{`${fmt(b.min_minor)}–${fmt(b.max_minor)}: ${Math.round(b.winRate * 100)}% win rate (${b.won} won, ${b.lost} lost)${marks ? ` · ${marks}` : ""}`}</title>
              </rect>
              <text x={padL + Math.max(2, w) + 6} y={yy + rowH / 2 + 4} fontSize={11} fill="var(--viz-ink)">{Math.round(b.winRate * 100)}% <tspan opacity={0.7}>({b.won}/{b.won + b.lost})</tspan></text>
              {marks && <text x={W - 2} y={yy + rowH / 2 + 4} textAnchor="end" fontSize={10} fill="var(--viz-ink)" fontWeight={600}>{marks}</text>}
            </g>
          );
        })}
      </svg>
      <Legend items={[{ label: "Win rate", swatch: "var(--viz-1)" }, { label: "Suggested band", swatch: "var(--viz-3)" }]} />
    </div>
  );
}
