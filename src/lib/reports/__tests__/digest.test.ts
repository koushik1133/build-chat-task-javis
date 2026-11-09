import { describe, expect, it } from "vitest";
import { buildDigestContent, buildScheduleContent, digestDue } from "@/lib/reports/digest";
import { reportCsv, reportHtmlTable } from "@/lib/reports/export";
import type { ReportResult } from "@/lib/reports/query";

const result: ReportResult = {
  dataset: "invoices",
  columns: [
    { key: "status", label: "Status", kind: "dimension", format: null, field: "status", agg: null, bucket: null },
    { key: "sum_total_minor", label: "Total", kind: "measure", format: "money", field: "total_minor", agg: "sum", bucket: null },
  ],
  rows: [{ status: "paid", sum_total_minor: 12000 }, { status: "=cmd()", sum_total_minor: 500 }],
  totals: { sum_total_minor: 12500 },
  row_count: 2, truncated: false, mode: "aggregate", currency: "USD", timezone: "UTC", generated_at: "2026-03-15T08:00:00.000Z",
};

describe("digest content", () => {
  it("builds subject, html and text with KPIs, needs-you links and report sections", () => {
    const c = buildDigestContent({
      orgName: "Acme <Co>",
      cadence: "weekly",
      kpis: [{ key: "revenue", label: "Revenue", value: "$1,200", hint: "+10% vs last month", deltaPct: 10 }],
      needsYou: [{ kind: "invoice", id: "i1", title: "Invoice #12 overdue", detail: "$300 · 5 days", href: "/billing", rank: 1 }],
      reports: [{ name: "Revenue by status", html: "<table></table>", link: "https://app.test/api/p/report/tok", row_count: 2 }],
      appUrl: "https://app.test",
    });
    expect(c.subject).toBe("Weekly digest · Acme <Co> · 1 needs you");
    expect(c.html).toContain("Acme &lt;Co&gt;");
    expect(c.html).toContain("▲ 10%");
    expect(c.html).toContain('href="https://app.test/billing"');
    expect(c.html).toContain("Download CSV");
    expect(c.text).toContain("Revenue: $1,200 (+10% vs last month)");
    expect(c.text).toContain("Invoice #12 overdue");
  });

  it("says when nothing needs you", () => {
    const c = buildDigestContent({ orgName: "A", cadence: "daily", kpis: [], needsYou: [], reports: [], appUrl: "https://x" });
    expect(c.subject).toBe("Daily digest · A");
    expect(c.html).toContain("Nothing is waiting on you");
  });

  it("scheduled report mail inlines the table and escapes cells", () => {
    const c = buildScheduleContent({ report: { name: "Rev", description: null }, result, format: "inline", link: null, appUrl: "https://x", cadence: "weekly" });
    expect(c.subject).toBe("Rev · weekly report");
    expect(c.html).toContain("<table");
    expect(c.html).toContain("$120.00");
    expect(c.html).toContain("Total");
    const withLink = buildScheduleContent({ report: { name: "Rev", description: null }, result, format: "pdf", link: "https://x/api/p/report/t?format=pdf", appUrl: "https://x", cadence: "daily" });
    expect(withLink.html).toContain("Download PDF");
  });

  it("csv export escapes formulas and appends totals", () => {
    const csv = reportCsv(result);
    expect(csv).toContain("Status,Total");
    expect(csv).toContain("'=cmd()");
    expect(csv.trim().split("\r\n").at(-1)).toBe("Total,12500");
    expect(reportHtmlTable(result, 1)).toContain("Showing 1 of 2 rows");
  });

  it("digestDue anchors on the last send in the org zone", () => {
    const now = new Date("2026-03-16T02:35:00Z"); // 08:05 IST Monday
    const prefs = { digest: "daily" as const, digest_hour: 8, digest_weekday: 1 };
    expect(digestDue(prefs, null, now, "Asia/Kolkata")).toBe(true);
    expect(digestDue(prefs, "2026-03-16T02:31:00Z", now, "Asia/Kolkata")).toBe(false);
    expect(digestDue(prefs, "2026-03-15T02:31:00Z", now, "Asia/Kolkata")).toBe(true);
    expect(digestDue({ ...prefs, digest: "weekly" }, "2026-03-10T02:31:00Z", now, "Asia/Kolkata")).toBe(true);
    expect(digestDue({ ...prefs, digest: "weekly" }, "2026-03-16T02:31:00Z", now, "Asia/Kolkata")).toBe(false);
    expect(digestDue({ ...prefs, digest: "off" }, null, now, "UTC")).toBe(false);
  });
});
