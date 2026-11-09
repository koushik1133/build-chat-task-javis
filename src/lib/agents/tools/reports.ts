import { z } from "zod";
import { registerTool } from "@/lib/agents/registry";
import type { ToolResult } from "@/lib/agents/types";
import { ReportSpecSchema } from "@/lib/reports/spec";
import { listDatasets, resolveDataset, runReport, ReportSpecError, DatasetUnavailableError } from "@/lib/reports/query";
import { getSavedReportById, listSavedReports } from "@/lib/reports/store";
import { formattedRows, formattedTotals } from "@/lib/reports/export";

/** Reports tools: run an ad-hoc or saved report, list saved reports. Read-only, scoped to ctx.userId (org data id). */

function fail(error: string): ToolResult {
  return { ok: false, summary: error, error };
}

const RunInput = z
  .object({
    report_id: z.string().max(100).optional().describe("Run a saved report by id (ignores spec)"),
    spec: ReportSpecSchema.optional().describe("Ad-hoc report spec: dataset, filters, group_by, measures"),
    max_rows: z.number().int().min(1).max(200).optional(),
  })
  .refine((i) => Boolean(i.report_id) || Boolean(i.spec), "report_id or spec is required");
type RunInputT = z.infer<typeof RunInput>;

registerTool<RunInputT>({
  name: "reports.run",
  module: "reports",
  description:
    "Run a report. Either a saved report (report_id) or an ad-hoc spec {dataset, filters[{field, op, value}], group_by[{field, bucket}], measures[{field, agg}]}. Call reports.list_saved first to discover datasets/fields. Returns aggregated rows and totals; state the period used when answering.",
  input: RunInput,
  parameters: {
    type: "object",
    properties: {
      report_id: { type: "string", description: "Saved report id (optional)" },
      spec: {
        type: "object",
        description: "Ad-hoc spec. dataset: e.g. invoices, payments, tickets, bookings, expenses; filters ops: eq, neq, in, contains, gt, gte, lt, lte, between, is_null, not_null, date_range ({preset: last_30_days|this_month|...}); group_by bucket: day|week|month|quarter|year; measures agg: count|sum|avg|min|max|count_distinct",
        properties: {
          dataset: { type: "string" },
          filters: { type: "array", items: { type: "object" } },
          group_by: { type: "array", items: { type: "object" } },
          measures: { type: "array", items: { type: "object" } },
          limit: { type: "number" },
        },
        required: ["dataset"],
      },
      max_rows: { type: "number", description: "Rows to return to the model (default 50, max 200)" },
    },
  },
  scope: "read",
  preview: (i) => (i.report_id ? `Run saved report ${i.report_id}` : `Run report on ${i.spec?.dataset ?? "dataset"}`),
  async run(ctx, input) {
    try {
      let spec = input.spec ?? null;
      let name = spec ? `Ad-hoc ${spec.dataset}` : "";
      if (input.report_id) {
        const saved = await getSavedReportById(ctx.userId, input.report_id);
        if (!saved) return fail("Saved report not found.");
        spec = saved.spec;
        name = saved.name;
      }
      if (!spec) return fail("Provide report_id or spec.");
      const ds = await resolveDataset(ctx.userId, spec.dataset);
      if (!ds) return fail(`Dataset ${spec.dataset} is not available. Call reports.list_saved to see datasets.`);
      const result = await runReport(ctx.userId, spec, { dataset: ds });
      const max = input.max_rows ?? 50;
      const rows = formattedRows({ ...result, rows: result.rows.slice(0, max) });
      return {
        ok: true,
        summary: `${name}: ${result.rows.length} row${result.rows.length === 1 ? "" : "s"}${result.truncated ? " (truncated)" : ""}`,
        data: { name, dataset: result.dataset, columns: result.columns.map((c) => ({ key: c.key, label: c.label, kind: c.kind })), rows, totals: formattedTotals(result), row_count: result.rows.length, truncated: result.truncated || result.rows.length > max, timezone: result.timezone, currency: result.currency },
      };
    } catch (err) {
      if (err instanceof ReportSpecError || err instanceof DatasetUnavailableError) return fail(err.message);
      return fail(err instanceof Error ? err.message : String(err));
    }
  },
});

const ListInput = z.object({ include_datasets: z.boolean().optional().describe("Also return the dataset catalogue with fields (default true)") });
type ListInputT = z.infer<typeof ListInput>;

registerTool<ListInputT>({
  name: "reports.list_saved",
  module: "reports",
  description: "List saved reports (id, name, dataset, chart) and the dataset catalogue with field keys, kinds and allowed aggregations. Use before reports.run to pick valid field names.",
  input: ListInput,
  parameters: { type: "object", properties: { include_datasets: { type: "boolean", description: "Include the dataset catalogue (default true)" } } },
  scope: "read",
  preview: () => "List saved reports",
  async run(ctx, input) {
    try {
      const [reports, datasets] = await Promise.all([
        listSavedReports(ctx.userId, ctx.userId, 100),
        input.include_datasets === false ? Promise.resolve([]) : listDatasets(ctx.userId, () => true),
      ]);
      return {
        ok: true,
        summary: `${reports.length} saved report${reports.length === 1 ? "" : "s"}, ${datasets.length} dataset${datasets.length === 1 ? "" : "s"}`,
        data: {
          reports: reports.map((r) => ({ id: r.id, name: r.name, description: r.description, dataset: r.spec.dataset, chart: r.chart.type, updated_at: r.updated_at })),
          datasets: datasets.map((d) => ({ key: d.key, label: d.label, default_date: d.default_date, fields: d.fields.map((f) => `${f.key} (${f.kind}${f.format ? `, ${f.format}` : ""})`) })),
        },
      };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  },
});
