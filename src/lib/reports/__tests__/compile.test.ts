import { describe, expect, it } from "vitest";
import { compileReport, ReportSpecError } from "@/lib/reports/compile";
import { STATIC_DATASETS, recordsDataset } from "@/lib/reports/datasets";
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
});
