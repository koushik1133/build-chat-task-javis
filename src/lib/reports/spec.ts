import { z } from "zod";
import { AGGREGATIONS, DATE_BUCKETS } from "./datasets";

/** Report spec + chart config schemas. Client-safe (zod only). */

export const FILTER_OPS = ["eq", "neq", "in", "not_in", "contains", "gt", "gte", "lt", "lte", "between", "is_null", "not_null", "date_range"] as const;
export type FilterOp = (typeof FILTER_OPS)[number];

export const DATE_PRESETS = ["today", "yesterday", "last_7_days", "last_30_days", "last_90_days", "this_week", "last_week", "this_month", "last_month", "this_quarter", "this_year", "last_year"] as const;
export type DatePreset = (typeof DATE_PRESETS)[number];

const Scalar = z.union([z.string().max(500), z.number(), z.boolean(), z.null()]);

export const DateRangeValue = z.union([
  z.object({ preset: z.enum(DATE_PRESETS) }).strict(),
  z.object({ from: z.string().max(40).optional().nullable(), to: z.string().max(40).optional().nullable() }).strict(),
]);

export const FilterSchema = z
  .object({
    field: z.string().min(1).max(80),
    op: z.enum(FILTER_OPS),
    value: z.union([Scalar, z.array(Scalar).max(200), DateRangeValue]).optional(),
  })
  .strict();

export const GroupBySchema = z.object({ field: z.string().min(1).max(80), bucket: z.enum(DATE_BUCKETS).optional() }).strict();
export const MeasureSchema = z.object({ field: z.string().min(1).max(80).optional(), agg: z.enum(AGGREGATIONS), label: z.string().max(80).optional() }).strict();
export const SortSchema = z.object({ by: z.string().min(1).max(120), dir: z.enum(["asc", "desc"]).default("desc") }).strict();

export const ReportSpecSchema = z
  .object({
    dataset: z.string().min(1).max(140),
    /** Raw mode: columns to list when there are no measures/group-bys. */
    columns: z.array(z.string().min(1).max(80)).max(30).optional(),
    filters: z.array(FilterSchema).max(20).default([]),
    group_by: z.array(GroupBySchema).max(4).default([]),
    measures: z.array(MeasureSchema).max(8).default([]),
    sort: z.array(SortSchema).max(3).optional(),
    limit: z.number().int().min(1).max(5000).optional(),
  })
  .strict();
export type ReportSpec = z.infer<typeof ReportSpecSchema>;
export type ReportSpecInput = z.input<typeof ReportSpecSchema>;
export type ReportFilter = z.infer<typeof FilterSchema>;

export const CHART_TYPES = ["table", "bar", "line", "pie", "kpi"] as const;
export type ChartType = (typeof CHART_TYPES)[number];

export const ChartConfigSchema = z
  .object({
    type: z.enum(CHART_TYPES).default("table"),
    /** Output column used for the x axis / slices. */
    x: z.string().max(120).optional().nullable(),
    /** Output column(s) plotted. */
    y: z.array(z.string().max(120)).max(6).optional().nullable(),
    /** Output column that splits y into series (bar/line). */
    series: z.string().max(120).optional().nullable(),
  })
  .strict();
export type ChartConfig = z.infer<typeof ChartConfigSchema>;

export const MAX_REPORT_ROWS = 5000;
export const DEFAULT_REPORT_ROWS = 500;
