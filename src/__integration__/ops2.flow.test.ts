/**
 * Operations flow (Phase 10 lane C): metrics endpoint auth, request-id echo,
 * default alert rule seeding, alert fire -> chat notification -> auto-resolve,
 * and the audit category filter + CSV export.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { api, call, cleanupDataIds, createTestOrg, describeDb, req, setScope, sql, type TestOrg } from "./setup";

vi.mock("@/lib/auth/scope", () => import("./setup").then((m) => m.scopeMockFactory()));
vi.mock("@/lib/supabase/server", () => import("./setup").then((m) => m.supabaseMockFactory()));

interface Rule { id: string; key: string; enabled: boolean; channel_ids: string[]; condition: { threshold: number } }

describeDb("ops2 flow", () => {
  let org: TestOrg;
  let server: Server;
  let url = "";
  const received: string[] = [];

  beforeAll(async () => {
    process.env.CREDENTIAL_ENCRYPTION_KEY = process.env.CREDENTIAL_ENCRYPTION_KEY || "a".repeat(64);
    org = await createTestOrg("ops2");
    server = createServer((rq, rs) => {
      let b = "";
      rq.on("data", (c) => (b += c));
      rq.on("end", () => { received.push(b); rs.writeHead(200).end("ok"); });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await sql(`DELETE FROM alert_events WHERE rule_id LIKE $1`, [`dflt:${org.dataId}:%`]).catch(() => undefined);
    await cleanupDataIds([org.dataId]);
  });

  it("/api/metrics is 404 without METRICS_TOKEN, 401 with a wrong bearer, 200 with the right one", async () => {
    const route = await import("@/app/api/metrics/route");
    delete process.env.METRICS_TOKEN;
    expect((await call(route.GET, req("/api/metrics"))).status).toBe(404);
    process.env.METRICS_TOKEN = "metrics-token-for-tests-123";
    expect((await call(route.GET, req("/api/metrics", { headers: { authorization: "Bearer nope" } }))).status).toBe(401);
    const ok = await call<string>(route.GET, req("/api/metrics", { headers: { authorization: "Bearer metrics-token-for-tests-123" } }), {}, 200);
    expect(ok.text).toContain("# TYPE kh_cron_last_tick_age_minutes gauge".slice(0, 6));
    expect(ok.res.headers.get("content-type")).toContain("text/plain");
    delete process.env.METRICS_TOKEN;
  });

  it("wrapped routes echo x-request-id", async () => {
    const { withRequestContext } = await import("@/lib/log/context");
    const h = withRequestContext(async () => new Response("ok"));
    const res = await h(req("/api/shop/x", { headers: { "x-request-id": "itest-req-0001" } }));
    expect(res.headers.get("x-request-id")).toBe("itest-req-0001");
  });

  it("seeds default rules idempotently (3 enabled)", async () => {
    setScope(org, { role: "owner" });
    const rules = await import("@/app/api/alerts/rules/route");
    const a = await api<{ rules: Rule[] }>(rules.GET, "/api/alerts/rules", { expect: 200 });
    const b = await api<{ rules: Rule[] }>(rules.GET, "/api/alerts/rules", { expect: 200 });
    expect(b.body.rules.length).toBe(a.body.rules.length);
    expect(a.body.rules.filter((r) => r.enabled).map((r) => r.key).sort()).toEqual(["ai_budget", "outbox_failed", "webhook_dead"]);
  });

  it("fires on failed outbox rows, notifies chat, then auto-resolves", async () => {
    setScope(org, { role: "owner" });
    const { createIntegration } = await import("@/lib/chatops/subscriptions");
    const integ = await createIntegration(org.dataId, { provider: "webhook", name: "ops", webhook_url: url, events: [] });
    const rules = (await (await import("@/app/api/alerts/rules/route")).GET().then((r) => r.json())) as { rules: Rule[] };
    const rule = rules.rules.find((r) => r.key === "outbox_failed")!;
    const patch = await import("@/app/api/alerts/rules/[id]/route");
    await api(patch.PATCH, `/api/alerts/rules/${rule.id}`, { method: "PATCH", json: { channel_ids: [integ.id], threshold: 20 }, params: { id: rule.id }, expect: 200 });

    for (let i = 0; i < 25; i++) {
      await sql(`INSERT INTO notification_outbox (id, user_id, channel, recipient, status, attempts, created_at) VALUES ($1,$2,'email','x@example.test','failed',3,NOW())`, [randomUUID(), org.dataId]);
    }
    const { processAlerts } = await import("@/lib/alerts/process");
    const first = await processAlerts(500);
    expect(first.fired).toBeGreaterThanOrEqual(1);
    const events = await sql<{ id: string; resolved_at: string | null }>(`SELECT id, resolved_at FROM alert_events WHERE user_id = $1 AND rule_id = $2`, [org.dataId, rule.id]);
    expect(events).toHaveLength(1);
    expect(events[0].resolved_at).toBeNull();
    expect(received.some((b) => b.includes("Notification failures"))).toBe(true);

    // Still breached: no duplicate event, and the cooldown suppresses a second message.
    const before = received.length;
    await processAlerts(500);
    expect((await sql(`SELECT id FROM alert_events WHERE user_id = $1 AND rule_id = $2`, [org.dataId, rule.id])).length).toBe(1);
    expect(received.length).toBe(before);

    await sql(`DELETE FROM notification_outbox WHERE user_id = $1`, [org.dataId]);
    const second = await processAlerts(500);
    expect(second.resolved).toBeGreaterThanOrEqual(1);
    const after = await sql<{ resolved_at: string | null }>(`SELECT resolved_at FROM alert_events WHERE user_id = $1 AND rule_id = $2`, [org.dataId, rule.id]);
    expect(after[0].resolved_at).not.toBeNull();

    const evRoute = await import("@/app/api/alerts/events/route");
    const list = await api<{ events: Array<{ resolved_at: string | null }> }>(evRoute.GET, "/api/alerts/events", { expect: 200 });
    expect(list.body.events.length).toBe(1);
  });

  it("audit: category filter, date range and formula-safe CSV", async () => {
    setScope(org, { role: "owner" });
    const { recordAudit } = await import("@/lib/audit");
    await recordAudit({ dataId: org.dataId, userId: org.userId, email: "=cmd|evil@example.test" }, { action: "create", entity: "api_key", entityId: "k1", after: { name: "n" } });
    await recordAudit(org, { action: "update", entity: "document", entityId: "d1", after: { title: "x" } });
    const route = await import("@/app/api/audit/route");
    const access = await api<{ entries: Array<{ entity: string; category: string }> }>(route.GET, "/api/audit", { query: { category: "access" }, expect: 200 });
    expect(access.body.entries.map((e) => e.entity)).toEqual(["api_key"]);
    expect(access.body.entries[0].category).toBe("access");
    await api(route.GET, "/api/audit", { query: { category: "bogus" }, expect: 400 });
    const future = await api<{ entries: unknown[] }>(route.GET, "/api/audit", { query: { from: new Date(Date.now() + 86_400_000).toISOString() }, expect: 200 });
    expect(future.body.entries).toHaveLength(0);
    const csv = await call<string>(route.GET, req("/api/audit", { query: { format: "csv", category: "access" } }), {}, 200);
    expect(csv.res.headers.get("content-type")).toContain("text/csv");
    expect(csv.text).toContain("api_key");
    expect(csv.text).toContain("'=cmd|evil@example.test");
    expect(csv.text).not.toMatch(/,=cmd/);
  });
});
