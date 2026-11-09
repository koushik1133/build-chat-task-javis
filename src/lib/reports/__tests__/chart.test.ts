import { describe, expect, it } from "vitest";
import { defaultChart, formatValue, toChartData } from "@/lib/reports/chart";
import type { OutputColumn } from "@/lib/reports/compile";

const cols: OutputColumn[] = [
  { key: "created_at_month", label: "Created (month)", kind: "date", format: null, field: "created_at", agg: null, bucket: "month" },
  { key: "status", label: "Status", kind: "dimension", format: null, field: "status", agg: null, bucket: null },
  { key: "sum_total_minor", label: "Sum Total", kind: "measure", format: "money", field: "total_minor", agg: "sum", bucket: null },
  { key: "count", label: "Count", kind: "measure", format: "number", field: null, agg: "count", bucket: null },
];
const rows = [
  { created_at_month: "2026-01", status: "paid", sum_total_minor: 1000, count: 2 },
  { created_at_month: "2026-01", status: "sent", sum_total_minor: 500, count: 1 },
  { created_at_month: "2026-02", status: "paid", sum_total_minor: "2000", count: 3 },
];

describe("chart series mapping", () => {
  it("picks defaults: first dimension as x, second as series, measures as y", () => {
    const d = defaultChart(cols, { type: "bar" });
    expect(d).toEqual({ type: "bar", x: "created_at_month", y: ["sum_total_minor", "count"], series: "status" });
    expect(defaultChart(cols, { type: "pie" }).y).toEqual(["sum_total_minor"]);
  });

  it("pivots a series column into one series per value, summing duplicates", () => {
    const d = toChartData(rows, cols, { type: "bar", x: "created_at_month", y: ["sum_total_minor"], series: "status" });
    expect(d.categories).toEqual(["2026-01", "2026-02"]);
    expect(d.series).toEqual([
      { key: "paid", label: "paid", values: [1000, 2000] },
      { key: "sent", label: "sent", values: [500, null] },
    ]);
    expect(d.format).toBe("money");
  });

  it("plots several measures without a series column", () => {
    const d = toChartData(rows, cols, { type: "line", x: "status", y: ["sum_total_minor", "count"], series: null });
    expect(d.categories).toEqual(["paid", "sent", "paid"]);
    expect(d.series.map((s) => s.label)).toEqual(["Sum Total", "Count"]);
    expect(d.series[1].values).toEqual([2, 1, 3]);
  });

  it("kpi mode reads the first row", () => {
    const d = toChartData([{ sum_total_minor: 4200, count: 9 }], cols.slice(2), { type: "kpi" });
    expect(d.categories).toEqual(["Total"]);
    expect(d.series.map((s) => s.values[0])).toEqual([4200, 9]);
  });

  it("formats values by kind", () => {
    expect(formatValue(123456, "money", "USD")).toMatch(/1,234\.56/);
    expect(formatValue(90, "minutes", "USD")).toBe("1.5 h");
    expect(formatValue(12.5, "percent", "USD")).toBe("12.5%");
    expect(formatValue(null, "number", "USD")).toBe("—");
    expect(formatValue(true, null, "USD")).toBe("Yes");
  });
});
