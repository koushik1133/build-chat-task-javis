import type { DatasetDescription } from "@/lib/reports/datasets";
import type { OutputColumn } from "@/lib/reports/compile";
import type { ReportRow } from "@/lib/reports/chart";
import type { ChartConfig, ReportSpec } from "@/lib/reports/spec";

/** Client-side DTOs for /api/reports/* (mirrors the server shapes without importing DB modules). */

export type Catalogue = {
  datasets: DatasetDescription[];
  aggregations: readonly string[];
  buckets: readonly string[];
  ops: readonly string[];
  presets: readonly string[];
};

export interface RunResult {
  dataset: string;
  columns: OutputColumn[];
  rows: ReportRow[];
  totals: ReportRow | null;
  row_count: number;
  truncated: boolean;
  mode: "aggregate" | "raw";
  currency: string;
  timezone: string;
  generated_at: string;
}

export interface SavedReportDTO {
  id: string;
  name: string;
  description: string | null;
  spec: ReportSpec;
  chart: ChartConfig;
  visibility: "private" | "org";
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface ScheduleDTO {
  id: string;
  report_id: string;
  cadence: "daily" | "weekly" | "monthly";
  hour: number;
  weekday: number | null;
  day_of_month: number | null;
  recipients: string[];
  format: "csv" | "pdf" | "inline";
  enabled: boolean;
  last_sent_at: string | null;
  next_run_at: string | null;
}

export interface LayoutItemDTO {
  report_id?: string | null;
  builtin?: "kpis" | "needs_you" | "job_costing" | "agency_rollup" | "cashflow" | null;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface DashboardDTO {
  id: string;
  name: string;
  role: string | null;
  layout: LayoutItemDTO[];
  is_default: boolean;
  created_by: string | null;
}

export const EMPTY_SPEC: ReportSpec = { dataset: "", filters: [], group_by: [], measures: [] };
export const EMPTY_CHART: ChartConfig = { type: "bar" };

export const PRESET_LABELS: Record<string, string> = {
  today: "Today", yesterday: "Yesterday", last_7_days: "Last 7 days", last_30_days: "Last 30 days", last_90_days: "Last 90 days",
  this_week: "This week", last_week: "Last week", this_month: "This month", last_month: "Last month", this_quarter: "This quarter", this_year: "This year", last_year: "Last year",
};
export const OP_LABELS: Record<string, string> = {
  eq: "is", neq: "is not", in: "is any of", not_in: "is none of", contains: "contains", gt: ">", gte: "≥", lt: "<", lte: "≤", between: "between", is_null: "is empty", not_null: "is set", date_range: "in range",
};
