/**
 * Reports end-to-end: seed invoices/tickets → ad-hoc run grouped by month →
 * save → export CSV/PDF → schedule → sendDueReportSchedules enqueues an email
 * with a 7-day token → public CSV download → role default dashboard →
 * preferences gate an in-app notification → digest email.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { api, call, cleanupDataIds, createTestOrg, describeDb, req, setScope, sql, sqlOne, type TestOrg } from "./setup";

vi.mock("@/lib/auth/scope", () => import("./setup").then((m) => m.scopeMockFactory()));
vi.mock("@/lib/supabase/server", () => import("./setup").then((m) => m.supabaseMockFactory()));

interface RunResult { columns: Array<{ key: string }>; rows: Array<Record<string, string | number | null>>; totals: Record<string, number> | null; row_count: number }
interface SavedReport { id: string; name: string; spec: { dataset: string } }

describeDb("reports flow", () => {
  let org: TestOrg;
  let reportId: string;
  let scheduleId: string;
  let token: string;

  beforeAll(async () => {
    org = await createTestOrg("reports");
    setScope(org);
    const months = ["2026-01-10T10:00:00Z", "2026-01-20T10:00:00Z", "2026-02-05T10:00:00Z"];
    for (const [i, at] of months.entries()) {
      await sql(
        `INSERT INTO invoices (id, user_id, number, status, currency, subtotal_minor, tax_minor, total_minor, paid_minor, items, created_at, updated_at) VALUES ($1, $2, $3, $4, 'USD', $5, 0, $5, 0, '[]', $6, $6)`,
        [randomUUID(), org.dataId, `INV-${i + 1}`, i === 2 ? "sent" : "paid", (i + 1) * 10_000, at]
      );
    }
    for (let i = 0; i < 2; i++) {
      await sql(`INSERT INTO tickets (id, user_id, number, subject, status, priority, source, tags, created_at, updated_at) VALUES ($1, $2, $3, $4, 'open', 'normal', 'manual', '[]', NOW(), NOW())`, [randomUUID(), org.dataId, 100 + i, `Ticket ${i}`]);
    }
  });
  afterAll(async () => {
    await cleanupDataIds([org.dataId]);
  });

  it("lists datasets gated by role and probed tables", async () => {
    const route = await import("@/app/api/reports/datasets/route");
    const r = await api<{ datasets: Array<{ key: string; area: string }> }>(route.GET, "/api/reports/datasets", { expect: 200 });
    const keys = r.body.datasets.map((d) => d.key);
    expect(keys).toEqual(expect.arrayContaining(["invoices", "tickets", "payments", "contacts"]));
    setScope(org, { role: "member" });
    await api(route.GET, "/api/reports/datasets", { expect: 403 }); // members cannot view reports
    setScope(null);
    await api(route.GET, "/api/reports/datasets", { expect: 401 });
    setScope(org);
  });

  it("runs an ad-hoc report grouped by month with totals", async () => {
    const run = await import("@/app/api/reports/run/route");
    const r = await api<{ result: RunResult }>(run.POST, "/api/reports/run", {
      json: { dataset: "invoices", filters: [{ field: "created_at", op: "between", value: ["2026-01-01", "2026-12-31"] }], group_by: [{ field: "created_at", bucket: "month" }], measures: [{ field: "total_minor", agg: "sum" }, { agg: "count" }] },
      expect: 200,
    });
    expect(r.body.result.rows).toEqual([
      { created_at_month: "2026-01", sum_total_minor: 30_000, count: 2 },
      { created_at_month: "2026-02", sum_total_minor: 30_000, count: 1 },
    ]);
    expect(r.body.result.totals).toEqual({ sum_total_minor: 60_000, count: 3 });
    await api(run.POST, "/api/reports/run", { json: { dataset: "invoices", measures: [{ field: "nope", agg: "sum" }] }, expect: 400 });
    await api(run.POST, "/api/reports/run", { json: { dataset: "does_not_exist" }, expect: 404 });
    // tickets dataset needs helpdesk view: viewer role can view helpdesk but not reports
    setScope(org, { role: "viewer" });
    await api(run.POST, "/api/reports/run", { json: { dataset: "tickets" }, expect: 403 });
    setScope(org);
  });

  it("saves a report and exports CSV and PDF", async () => {
    const saved = await import("@/app/api/reports/saved/route");
    const r = await api<{ report: SavedReport }>(saved.POST, "/api/reports/saved", {
      json: { name: "Revenue by month", description: "Invoice totals", spec: { dataset: "invoices", filters: [], group_by: [{ field: "created_at", bucket: "month" }], measures: [{ field: "total_minor", agg: "sum" }] }, chart: { type: "bar" } },
      expect: 201,
    });
    reportId = r.body.report.id;
    const list = await api<{ reports: SavedReport[] }>(saved.GET, "/api/reports/saved", { expect: 200 });
    expect(list.body.reports.map((x) => x.id)).toContain(reportId);

    const exp = await import("@/app/api/reports/saved/[id]/export/route");
    const csv = await call(exp.GET, req(`/api/reports/saved/${reportId}/export?format=csv`), { id: reportId }, 200);
    expect(csv.res.headers.get("content-type")).toMatch(/text\/csv/);
    expect(csv.res.headers.get("content-disposition")).toMatch(/attachment; filename="Revenue-by-month-\d{4}-\d{2}-\d{2}\.csv"/);
    expect(csv.text).toContain("Created (month),Sum Total");
    expect(csv.text).toContain("2026-01,30000");
    const pdf = await call(exp.GET, req(`/api/reports/saved/${reportId}/export?format=pdf`), { id: reportId }, 200);
    expect(pdf.res.headers.get("content-type")).toBe("application/pdf");
    expect(pdf.res.headers.get("x-document-sha256")).toMatch(/^[a-f0-9]{64}$/);
    expect(pdf.text.startsWith("%PDF")).toBe(true);

    const one = await import("@/app/api/reports/saved/[id]/route");
    await call(one.GET, req(`/api/reports/saved/${randomUUID()}`), { id: randomUUID() }, 404);
  });

  it("schedules the report; the sweep enqueues an email with a 7-day CSV link", async () => {
    const schedules = await import("@/app/api/reports/schedules/route");
    const r = await api<{ schedule: { id: string; next_run_at: string } }>(schedules.POST, "/api/reports/schedules", {
      json: { report_id: reportId, cadence: "weekly", hour: 8, weekday: 1, recipients: ["finance@example.test"], format: "csv" },
      expect: 201,
    });
    scheduleId = r.body.schedule.id;
    expect(new Date(r.body.schedule.next_run_at).getTime()).toBeGreaterThan(Date.now());
    await api(schedules.POST, "/api/reports/schedules", { json: { report_id: reportId, recipients: ["not-an-email"] }, expect: 400 });

    // Force due and sweep.
    await sql(`UPDATE report_schedules SET next_run_at = NOW() - INTERVAL '1 minute' WHERE id = $1`, [scheduleId]);
    const { sendDueReportSchedules } = await import("@/lib/reports/digest");
    const out = await sendDueReportSchedules(10);
    expect(out.sent).toBe(1);
    const again = await sendDueReportSchedules(10);
    expect(again.sent).toBe(0);

    const mail = await sqlOne<{ subject: string; data: string; body: string }>(`SELECT subject, data, body FROM notification_outbox WHERE user_id = $1 AND recipient = 'finance@example.test' ORDER BY created_at DESC LIMIT 1`, [org.dataId]);
    expect(mail?.subject).toBe("Revenue by month · weekly report");
    const data = JSON.parse(mail?.data ?? "{}") as { link: string; category: string };
    expect(data.category).toBe("reports");
    expect(data.link).toMatch(/\/api\/p\/report\/[A-Za-z0-9_-]+$/);
    token = data.link.split("/").pop() ?? "";
    const sched = await sqlOne<{ last_sent_at: string | null; next_run_at: string }>(`SELECT last_sent_at, next_run_at FROM report_schedules WHERE id = $1`, [scheduleId]);
    expect(sched?.last_sent_at).toBeTruthy();
    expect(new Date(sched?.next_run_at ?? 0).getTime()).toBeGreaterThan(Date.now());
    const tok = await sqlOne<{ expires_at: string }>(`SELECT expires_at FROM share_tokens WHERE user_id = $1 AND kind = 'report' AND entity_id = $2`, [org.dataId, reportId]);
    expect(new Date(tok?.expires_at ?? 0).getTime() - Date.now()).toBeGreaterThan(6.9 * 86_400_000);
  });

  it("public token downloads the CSV (and PDF) without a session", async () => {
    setScope(null);
    const pub = await import("@/app/api/p/report/[token]/route");
    const r = await call(pub.GET, req(`/api/p/report/${token}`), { token }, 200);
    expect(r.res.headers.get("content-type")).toMatch(/text\/csv/);
    expect(r.text).toContain("2026-02,30000");
    const pdf = await call(pub.GET, req(`/api/p/report/${token}?format=pdf`), { token }, 200);
    expect(pdf.res.headers.get("content-type")).toBe("application/pdf");
    await call(pub.GET, req(`/api/p/report/bogus-token`), { token: "bogus-token" }, 404);
    setScope(org);
  });

  it("serves a starter dashboard, lets admins save a role default, and members read it", async () => {
    const dash = await import("@/app/api/dashboards/route");
    const starter = await api<{ dashboard: { layout: unknown[] }; saved: boolean }>(dash.GET, "/api/dashboards?default=1", { expect: 200 });
    expect(starter.body.saved).toBe(false);
    expect(starter.body.dashboard.layout.length).toBeGreaterThan(0);

    const created = await api<{ dashboard: { id: string; is_default: boolean; role: string } }>(dash.POST, "/api/dashboards", {
      json: { name: "Manager board", role: "manager", is_default: true, layout: [{ builtin: "kpis", x: 0, y: 0, w: 12, h: 1 }, { report_id: reportId, x: 0, y: 1, w: 6, h: 2 }] },
      expect: 201,
    });
    expect(created.body.dashboard.is_default).toBe(true);
    await api(dash.POST, "/api/dashboards", { json: { name: "x", layout: [{ x: 0, y: 0, w: 6, h: 2 }] }, expect: 400 });

    setScope(org, { role: "manager", userId: "itest-manager" });
    const mine = await api<{ dashboard: { id: string; name: string }; saved: boolean }>(dash.GET, "/api/dashboards?default=1", { expect: 200 });
    expect(mine.body.saved).toBe(true);
    expect(mine.body.dashboard.name).toBe("Manager board");
    // managers have reports view only → cannot save a role default
    await api(dash.POST, "/api/dashboards", { json: { name: "nope", role: "manager", is_default: true, layout: [] }, expect: 403 });
    setScope(org);

    const v1 = await import("@/app/api/v1/dashboards/route");
    void v1; // registry wiring compiled; auth via API key is covered by the v1 suites
  });

  it("preferences gate an in-app notification and defer push during quiet hours", async () => {
    const prefs = await import("@/app/api/notifications/preferences/route");
    const g = await api<{ preferences: { digest: string; channels: Record<string, Record<string, boolean>> } }>(prefs.GET, "/api/notifications/preferences", { expect: 200 });
    expect(g.body.preferences.digest).toBe("off");
    expect(g.body.preferences.channels.helpdesk.in_app).toBe(true);

    const p = await api<{ preferences: { channels: Record<string, Record<string, boolean>>; quiet_hours: { start: string; end: string } } }>(prefs.PATCH, "/api/notifications/preferences", {
      json: { channels: { helpdesk: { in_app: false } }, quiet_hours: { start: "00:00", end: "23:59" }, digest: "daily", digest_hour: 0 },
      expect: 200,
    });
    expect(p.body.preferences.channels.helpdesk.in_app).toBe(false);
    await api(prefs.PATCH, "/api/notifications/preferences", { json: { channels: { bogus: { in_app: true } } }, expect: 400 });

    const { enqueueNotification, SKIPPED_PREFIX } = await import("@/lib/notifications/outbox");
    const skipped = await enqueueNotification(org.dataId, { channel: "in_app", recipient: org.userId, subject: "SLA at risk", data: { category: "helpdesk", member_user_id: org.userId } });
    expect(skipped.startsWith(SKIPPED_PREFIX)).toBe(true);
    const none = await sqlOne<{ n: string }>(`SELECT COUNT(*) AS n FROM notification_outbox WHERE user_id = $1 AND subject = 'SLA at risk'`, [org.dataId]);
    expect(Number(none?.n)).toBe(0);

    // Different category is unaffected; push is deferred to the end of quiet hours.
    const ok = await enqueueNotification(org.dataId, { channel: "in_app", recipient: org.userId, subject: "Invoice paid", data: { category: "billing", member_user_id: org.userId } });
    expect(ok.startsWith(SKIPPED_PREFIX)).toBe(false);
    const pushId = await enqueueNotification(org.dataId, { channel: "push", recipient: org.userId, subject: "Approval needed", data: { category: "approvals", member_user_id: org.userId } });
    const push = await sqlOne<{ scheduled_at: string }>(`SELECT scheduled_at FROM notification_outbox WHERE id = $1`, [pushId]);
    expect(new Date(push?.scheduled_at ?? 0).getTime()).toBeGreaterThan(Date.now() + 60_000);
    // Notifications without a member/category are never gated.
    const plain = await enqueueNotification(org.dataId, { channel: "in_app", recipient: org.userId, subject: "Plain" });
    expect(plain.startsWith(SKIPPED_PREFIX)).toBe(false);
  });

  it("sends a daily digest email summarising needs-you, KPIs and scheduled reports", async () => {
    const { sendDueDigests } = await import("@/lib/reports/digest");
    const out = await sendDueDigests(10);
    expect(out.sent).toBe(1);
    const mail = await sqlOne<{ subject: string; body: string; data: string; recipient: string }>(`SELECT subject, body, data, recipient FROM notification_outbox WHERE user_id = $1 AND data LIKE '%"kind":"digest"%' ORDER BY created_at DESC LIMIT 1`, [org.dataId]);
    expect(mail?.recipient).toBe(org.email);
    expect(mail?.subject).toMatch(/^Daily digest · Integration reports/);
    expect(mail?.body).toContain("Open tickets");
    const second = await sendDueDigests(10);
    expect(second.sent).toBe(0);
    // Turning the reports email channel off suppresses the next digest.
    await sql(`UPDATE notification_preferences SET last_digest_at = NOW() - INTERVAL '2 days', channel_prefs = $2 WHERE user_id = $1`, [org.dataId, JSON.stringify({ reports: { email: false } })]);
    const third = await sendDueDigests(10);
    expect(third.sent).toBe(0);
  });
});
