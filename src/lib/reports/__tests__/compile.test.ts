import { describe, expect, it } from "vitest";
import { compileReport, ReportSpecError } from "@/lib/reports/compile";
import { AGGREGATIONS, DATE_BUCKETS, STATIC_DATASETS, recordsDataset } from "@/lib/reports/datasets";
import { ReportSpecSchema } from "@/lib/reports/spec";

const ctx = { dataId: "org-1", timeZone: "Asia/Kolkata", now: new Date("2026-03-15T10:30:00Z") };

function spec(input: unknown) {
  return ReportSpecSchema.parse(input);
}

describe("compileReport", () => {
  it("compiles a grouped monthly revenue report (snapshot)", () => {
    const c = compileReport(STATIC_DATASETS.invoices, spec({ dataset: "invoices", filters: [{ field: "created_at", op: "date_range", value: { preset: "this_year" } }, { field: "status", op: "in", value: ["paid", "sent"] }], group_by: [{ field: "created_at", bucket: "month" }], measures: [{ field: "total_minor", agg: "sum" }, { agg: "count" }], sort: [{ by: "sum_total_minor", dir: "desc" }], limit: 100 }), ctx);
    expect(c.sql).toMatchInlineSnapshot(`"SELECT to_char(date_trunc('month', (created_at AT TIME ZONE $5)), 'YYYY-MM') AS "created_at_month", COALESCE(SUM(total_minor), 0) AS "sum_total_minor", COUNT(*) AS "count" FROM invoices WHERE user_id = $1 AND created_at >= $2 AND created_at < $3 AND status = ANY($4::text[]) GROUP BY 1 ORDER BY "sum_total_minor" DESC NULLS LAST LIMIT $6"`);
    expect(c.values).toEqual(["org-1", "2025-12-31T18:30:00.000Z", "2026-12-31T18:30:00.000Z", ["paid", "sent"], "Asia/Kolkata", 100]);
    expect(c.totalsSql).toMatchInlineSnapshot(`"SELECT COALESCE(SUM(total_minor), 0) AS "sum_total_minor", COUNT(*) AS "count" FROM invoices WHERE user_id = $1 AND created_at >= $2 AND created_at < $3 AND status = ANY($4::text[])"`);
    expect(c.columns.map((x) => [x.key, x.kind, x.format])).toEqual([["created_at_month", "date", null], ["sum_total_minor", "measure", "money"], ["count", "measure", "number"]]);
  });

  it("compiles a raw listing with the default date ordering and soft-delete guard", () => {
    const c = compileReport(STATIC_DATASETS.contacts, spec({ dataset: "contacts", columns: ["full_name", "lifecycle", "deal_value"], filters: [{ field: "company", op: "contains", value: "50%_x" }] }), ctx);
    expect(c.sql).toMatchInlineSnapshot(`"SELECT full_name AS "full_name", lifecycle AS "lifecycle", deal_value AS "deal_value" FROM crm_contacts WHERE user_id = $1 AND deleted_at IS NULL AND company ILIKE $2 ORDER BY created_at DESC LIMIT $3"`);
    expect(c.values).toEqual(["org-1", "%50\\%\\_x%", 500]);
    expect(c.mode).toBe("raw");
    expect(c.totalsSql).toBeNull();
  });

  it("joins payments through invoices and scopes on i.user_id", () => {
    const c = compileReport(STATIC_DATASETS.payments, spec({ dataset: "payments", group_by: [{ field: "provider" }], measures: [{ field: "net_minor", agg: "sum" }] }), ctx);
    expect(c.sql).toContain("FROM invoice_payments p JOIN invoices i ON i.id = p.invoice_id WHERE i.user_id = $1");
    expect(c.sql).toContain(`COALESCE(SUM((p.amount_minor - COALESCE(p.refunded_minor, 0))), 0) AS "sum_net_minor"`);
  });

  it("binds record JSON keys as parameters, never as identifiers", () => {
    const ds = recordsDataset({ id: "t1", name: "Deals", fields: [{ key: "region", label: "Region", type: "select", options: ["N"] }, { key: "value", label: "Value", type: "money" }, { key: "bad key; DROP", label: "x", type: "text" }] });
    expect(ds.fields.some((f) => f.jsonKey === "bad key; DROP")).toBe(false);
    const c = compileReport(ds, spec({ dataset: "records:t1", group_by: [{ field: "f_region" }], measures: [{ field: "f_value", agg: "sum" }], filters: [{ field: "f_region", op: "eq", value: "North" }] }), { ...ctx, recordTypeId: "t1" });
    expect(c.sql).toMatchInlineSnapshot(`"SELECT (data::jsonb ->> $5) AS "f_region", COALESCE(SUM(NULLIF((data::jsonb ->> $6), '')::numeric), 0) AS "sum_f_value" FROM records WHERE user_id = $1 AND deleted_at IS NULL AND type_id = $2 AND (data::jsonb ->> $3) = $4 GROUP BY 1 ORDER BY 1 ASC LIMIT $7"`);
    expect(c.values).toEqual(["org-1", "t1", "region", "North", "region", "value", 500]);
  });

  it("rejects unknown fields, disallowed aggregations, bad sorts and oversized limits", () => {
    expect(() => compileReport(STATIC_DATASETS.invoices, spec({ dataset: "invoices", measures: [{ field: "nope", agg: "sum" }] }), ctx)).toThrow(ReportSpecError);
    expect(() => compileReport(STATIC_DATASETS.invoices, spec({ dataset: "invoices", measures: [{ field: "status", agg: "sum" }] }), ctx)).toThrow(/not allowed/);
    expect(() => compileReport(STATIC_DATASETS.invoices, spec({ dataset: "invoices", group_by: [{ field: "status", bucket: "month" }] }), ctx)).toThrow(/date fields/);
    expect(() => compileReport(STATIC_DATASETS.invoices, spec({ dataset: "invoices", sort: [{ by: "total_minor; DROP TABLE x", dir: "asc" }] }), ctx)).toThrow(/Cannot sort/);
    expect(() => spec({ dataset: "invoices", limit: 50_000 })).toThrow();
    const c = compileReport(STATIC_DATASETS.invoices, spec({ dataset: "invoices", limit: 5000 }), ctx);
    expect(c.values.at(-1)).toBe(5000);
  });

  it("never lets user-provided strings reach the SQL text (fuzz)", () => {
    const nasties = ["status; DROP TABLE invoices--", "\"; SELECT 1", "' OR 1=1 --", "$1", "user_id", "created_at) FROM x --", "${process.env}", "\u0000", "ÿ", "a".repeat(80)];
    for (const n of nasties) {
      // as a field name: rejected
      expect(() => compileReport(STATIC_DATASETS.tickets, spec({ dataset: "tickets", filters: [{ field: n, op: "eq", value: "x" }] }), ctx)).toThrow(ReportSpecError);
      expect(() => compileReport(STATIC_DATASETS.tickets, spec({ dataset: "tickets", group_by: [{ field: n }] }), ctx)).toThrow(ReportSpecError);
      // as a value: only ever a bound parameter
      const c = compileReport(STATIC_DATASETS.tickets, spec({ dataset: "tickets", filters: [{ field: "status", op: "eq", value: n }, { field: "subject_contains", op: "eq", value: "x" }].slice(0, 1), measures: [{ agg: "count", label: n }] }), ctx);
      if (!["$1", "user_id"].includes(n)) expect(c.sql).not.toContain(n);
      expect(c.values).toContain(n);
      // labels are metadata only
      expect(c.columns[0].label).toBe(n);
    }
  });

  it("handles null-aware and comparison operators", () => {
    const c = compileReport(STATIC_DATASETS.tickets, spec({ dataset: "tickets", filters: [{ field: "assigned_to", op: "is_null" }, { field: "resolved_at", op: "not_null" }, { field: "first_response_minutes", op: "gt", value: 30 }, { field: "priority", op: "not_in", value: ["low"] }, { field: "contact_id", op: "eq", value: null }], measures: [{ field: "resolution_minutes", agg: "avg" }] }), ctx);
    expect(c.sql).toContain("assigned_to IS NULL AND resolved_at IS NOT NULL AND (EXTRACT(EPOCH FROM (first_responded_at - created_at)) / 60) > $2 AND priority <> ALL($3::text[]) AND contact_id IS NULL");
    expect(c.sql).toContain(`AVG((EXTRACT(EPOCH FROM (resolved_at - created_at)) / 60)) AS "avg_resolution_minutes"`);
  });

  it("between on dates is end-of-day inclusive in the org zone", () => {
    const c = compileReport(STATIC_DATASETS.bookings, spec({ dataset: "bookings", filters: [{ field: "starts_at", op: "between", value: ["2026-03-01", "2026-03-31"] }] }), ctx);
    expect(c.sql).toContain("starts_at >= $2 AND starts_at < $3");
    expect(c.values[1]).toBe("2026-02-28T18:30:00.000Z");
    expect(c.values[2]).toBe("2026-03-31T18:30:00.000Z");
  });

  it("dedupes output keys and defaults a date dimension to a day string", () => {
    const c = compileReport(STATIC_DATASETS.expenses, spec({ dataset: "expenses", group_by: [{ field: "spent_at" }], measures: [{ field: "amount_minor", agg: "sum" }, { field: "amount_minor", agg: "sum" }] }), ctx);
    expect(c.columns.map((x) => x.key)).toEqual(["spent_at", "sum_amount_minor", "sum_amount_minor_2"]);
    expect(c.sql).toContain("to_char(spent_at AT TIME ZONE $2, 'YYYY-MM-DD')");
  });

  it("compiles every dataset × field × allowed aggregation × bucket without throwing and with balanced parameters", () => {
    const datasets = [...Object.values(STATIC_DATASETS), recordsDataset({ id: "t1", name: "Deals", fields: [{ key: "stage_score", label: "Score", type: "number" }, { key: "closes_on", label: "Closes", type: "date" }, { key: "region", label: "Region", type: "text" }] as never })];
    let compiled = 0;
    for (const ds of datasets) {
      const recordTypeId = ds.key.startsWith("records:") ? "t1" : null;
      const dates = ds.fields.filter((f) => f.kind === "date");
      for (const f of ds.fields) {
        const aggs = f.aggregations ?? (f.kind === "dimension" ? ["count", "count_distinct"] : ["sum", "avg", "min", "max", "count", "count_distinct"]);
        for (const agg of aggs) {
          for (const bucket of [undefined, ...DATE_BUCKETS]) {
            const groupBy = bucket ? [{ field: dates[0]?.key ?? ds.defaultDate, bucket }] : [{ field: ds.fields.find((x) => x.kind === "dimension")?.key ?? ds.defaultDate }];
            const c = compileReport(ds, spec({ dataset: ds.key, filters: [{ field: ds.defaultDate, op: "date_range", value: { preset: "last_30_days" } }], group_by: groupBy, measures: [{ field: f.key, agg }] }), { ...ctx, recordTypeId });
            compiled++;
            // Every $n placeholder in the SQL must be bound, and vice versa.
            const placeholders = new Set([...c.sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])));
            expect(Math.max(...placeholders), `${ds.key}.${f.key} ${agg} ${bucket ?? "-"}`).toBe(c.values.length);
            expect(c.totalsSql).not.toBeNull();
            const tph = new Set([...(c.totalsSql ?? "").matchAll(/\$(\d+)/g)].map((m) => Number(m[1])));
            expect(Math.max(...tph)).toBe(c.totalsValues.length);
            expect(c.columns.filter((x) => x.kind === "measure")).toHaveLength(1);
            expect(c.columns[0].kind).toBe(bucket ? "date" : ds.fields.find((x) => x.key === groupBy[0].field)?.kind);
          }
        }
        // Disallowed aggregations throw a ReportSpecError rather than emitting SQL.
        for (const agg of AGGREGATIONS.filter((a) => !aggs.includes(a))) {
          expect(() => compileReport(ds, spec({ dataset: ds.key, measures: [{ field: f.key, agg }] }), { ...ctx, recordTypeId })).toThrow(ReportSpecError);
        }
      }
      // Raw mode: every field listable; a bucket on a non-date field throws.
      const raw = compileReport(ds, spec({ dataset: ds.key, columns: ds.fields.map((f) => f.key) }), { ...ctx, recordTypeId });
      expect(raw.columns.map((c) => c.key)).toEqual(ds.fields.map((f) => f.key));
      const dim = ds.fields.find((f) => f.kind !== "date");
      if (dim) expect(() => compileReport(ds, spec({ dataset: ds.key, group_by: [{ field: dim.key, bucket: "month" }] }), { ...ctx, recordTypeId })).toThrow(ReportSpecError);
    }
    expect(compiled).toBeGreaterThan(1500);
  });

  it("totals SQL re-binds every filter and keeps measure keys aligned with the row query", () => {
    const c = compileReport(
      STATIC_DATASETS.tickets,
      spec({
        dataset: "tickets",
        filters: [
          { field: "status", op: "neq", value: "closed" },
          { field: "priority", op: "in", value: ["urgent", "high"] },
          { field: "first_response_minutes", op: "gte", value: 5 },
          { field: "created_at", op: "date_range", value: { from: "2026-01-01", to: "2026-01-31" } },
        ],
        group_by: [{ field: "created_at", bucket: "week" }, { field: "priority" }],
        measures: [{ field: "first_response_minutes", agg: "avg" }, { field: "id", agg: "count_distinct" }, { agg: "count" }],
      }),
      ctx
    );
    expect(c.columns.map((x) => x.key)).toEqual(["created_at_week", "priority", "avg_first_response_minutes", "count_distinct_id", "count"]);
    expect(c.sql).toContain(`GROUP BY 1, 2 ORDER BY 1 ASC, 2 ASC`);
    expect(c.totalsSql).toBe(`SELECT AVG((EXTRACT(EPOCH FROM (first_responded_at - created_at)) / 60)) AS "avg_first_response_minutes", COUNT(DISTINCT id) AS "count_distinct_id", COUNT(*) AS "count" FROM tickets WHERE user_id = $1 AND status <> $2 AND priority = ANY($3::text[]) AND (EXTRACT(EPOCH FROM (first_responded_at - created_at)) / 60) >= $4 AND created_at >= $5 AND created_at < $6`);
    expect(c.totalsValues).toEqual(["org-1", "closed", ["urgent", "high"], 5, "2025-12-31T18:30:00.000Z", "2026-01-31T18:30:00.000Z"]);
  });
});
