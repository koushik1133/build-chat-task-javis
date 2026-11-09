import type { OutputColumn } from "./compile";
import type { ChartConfig } from "./spec";

/**
 * Aggregated rows → chart series. Pure and client-safe; the SVG components
 * and the PDF/CSV renderers all consume this shape.
 */

export type ReportRow = Record<string, string | number | boolean | null>;

export interface ChartSeries {
  key: string;
  label: string;
  values: Array<number | null>;
}

export interface ChartData {
  /** x labels in row order (distinct when `series` splits). */
  categories: string[];
  series: ChartSeries[];
  /** Format hint for the y axis (from the first y column). */
  format: OutputColumn["format"];
}

export const MAX_SERIES = 8;

export function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

const str = (v: unknown) => (v === null || v === undefined ? "—" : String(v));

/** Pick sensible defaults when the saved chart has no axes. */
export function defaultChart(columns: OutputColumn[], chart: ChartConfig): Required<Pick<ChartConfig, "type">> & ChartConfig {
  const dims = columns.filter((c) => c.kind !== "measure");
  const measures = columns.filter((c) => c.kind === "measure");
  const x = chart.x && columns.some((c) => c.key === chart.x) ? chart.x : (dims[0]?.key ?? null);
  const y = chart.y?.filter((k) => columns.some((c) => c.key === k)) ?? [];
  const series = chart.series && columns.some((c) => c.key === chart.series) && chart.series !== x ? chart.series : (dims.length > 1 && dims[1].key !== x ? dims[1].key : null);
  return { type: chart.type ?? "table", x, y: y.length ? y : measures.slice(0, chart.type === "pie" ? 1 : chart.type === "kpi" ? 4 : 3).map((m) => m.key), series };
}

export function toChartData(rows: ReportRow[], columns: OutputColumn[], chart: ChartConfig): ChartData {
  const cfg = defaultChart(columns, chart);
  const yKeys = cfg.y ?? [];
  const format = columns.find((c) => c.key === yKeys[0])?.format ?? null;
  const label = (k: string) => columns.find((c) => c.key === k)?.label ?? k;
  if (!cfg.x) {
    // KPI style: one row, each y is a series with a single value.
    return { categories: ["Total"], series: yKeys.map((k) => ({ key: k, label: label(k), values: [num(rows[0]?.[k])] })), format };
  }
  const xKey = cfg.x;
  if (cfg.series && yKeys.length > 0) {
    const sKey = cfg.series;
    const yKey = yKeys[0];
    const categories: string[] = [];
    const seriesNames: string[] = [];
    const cell = new Map<string, number | null>();
    for (const r of rows) {
      const cx = str(r[xKey]);
      const cs = str(r[sKey]);
      if (!categories.includes(cx)) categories.push(cx);
      if (!seriesNames.includes(cs)) {
        if (seriesNames.length >= MAX_SERIES) continue;
        seriesNames.push(cs);
      }
      cell.set(`${cx}\u0000${cs}`, (cell.get(`${cx}\u0000${cs}`) ?? 0) + (num(r[yKey]) ?? 0));
    }
    return { categories, series: seriesNames.map((s) => ({ key: s, label: s, values: categories.map((c) => cell.get(`${c}\u0000${s}`) ?? null) })), format };
  }
  const categories = rows.map((r) => str(r[xKey]));
  return { categories, series: yKeys.slice(0, MAX_SERIES).map((k) => ({ key: k, label: label(k), values: rows.map((r) => num(r[k])) })), format };
}

/** Display formatting for cells and axis ticks. */
export function formatValue(v: unknown, format: OutputColumn["format"], currency = "USD", compact = false): string {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  const n = num(v);
  if (n === null) return String(v);
  try {
    if (format === "money") return new Intl.NumberFormat(undefined, { style: "currency", currency, notation: compact ? "compact" : "standard", maximumFractionDigits: compact ? 1 : 2 }).format(n / 100);
    if (format === "minutes") return n >= 60 ? `${(n / 60).toFixed(1)} h` : `${Math.round(n)} min`;
    if (format === "percent") return `${n.toFixed(1)}%`;
    return new Intl.NumberFormat(undefined, { notation: compact ? "compact" : "standard", maximumFractionDigits: Number.isInteger(n) ? 0 : 2 }).format(n);
  } catch {
    return String(n);
  }
}
