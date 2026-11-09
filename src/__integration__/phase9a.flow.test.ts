/**
 * Phase 9 lane A: agent-run principal, order unfulfil + counts, project open
 * filter, paginated marketing lists with audience_name, sequence step sent once.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { api, cleanupDataIds, createTestOrg, describeDb, setScope, sql, sqlOne, type TestOrg } from "./setup";

vi.mock("@/lib/auth/scope", () => import("./setup").then((m) => m.scopeMockFactory()));
vi.mock("@/lib/supabase/server", () => import("./setup").then((m) => m.supabaseMockFactory()));

describeDb("phase 9 lane A", () => {
  let org: TestOrg;
  beforeAll(async () => {
    org = await createTestOrg("p9a");
    setScope(org);
  });
  afterAll(async () => {
    await cleanupDataIds([org.dataId]);
  });

  it("a run started by a write:agents key carries no billing access", async () => {
    const agentId = randomUUID();
    await sql(`INSERT INTO agents (id, user_id, name, role, status, autonomy_level, tools) VALUES ($1::uuid, $2, 'P9 bot', 'Ops', 'idle', 'approve', $3)`, [agentId, org.dataId, JSON.stringify(["reports.run"])]);
    const { startRun, getRun } = await import("@/lib/agents/runner");
    const { principalFromApiScopes, canFromStored } = await import("@/lib/agents/principal");
    const runId = await startRun(org.dataId, agentId, { prompt: "x", enqueue: false, principal: principalFromApiScopes(["write:agents"]) });
    const run = await getRun(runId, org.dataId);
    expect(run?.principal_role).toBe("api_key");
    const can = canFromStored(run?.principal_permissions);
    expect(can?.("agents", true)).toBe(true);
    expect(can?.("billing")).toBe(false);

    await import("@/lib/agents/tools");
    const { getTool } = await import("@/lib/agents/registry");
    const tool = getTool("reports.run")!;
    const spec = { dataset: "invoices", filters: [], group_by: [], measures: [{ agg: "count" }] };
    const denied = await tool.run({ userId: org.dataId, runId, agentId, autonomy: "approve", can }, { spec } as never);
    expect(denied.ok).toBe(false);
    // A system run (no stored principal) falls back to the owner matrix and may read billing datasets.
    const sys = await startRun(org.dataId, agentId, { prompt: "y", enqueue: false });
    const sysRun = await getRun(sys, org.dataId);
    expect(sysRun?.principal_permissions).toBeNull();
    const allowed = await tool.run({ userId: org.dataId, runId: sys, agentId, autonomy: "approve", can: canFromStored(sysRun?.principal_permissions) }, { spec } as never);
    expect(allowed.ok).toBe(true);
  });

  it("orders: counts always present, unfulfil moves fulfilled back to paid", async () => {
    const id = randomUUID();
    await sql(`INSERT INTO orders (id, user_id, number, status, customer_name, customer_email, items, total_minor, currency, fulfilled_at, created_at, updated_at) VALUES ($1, $2, 'ORD-P9A1', 'fulfilled', 'Pat', 'pat@example.test', '[]', 1000, 'USD', NOW(), NOW(), NOW())`, [id, org.dataId]);
    const list = await import("@/app/api/orders/route");
    const first = await api<{ counts: Record<string, number>; next_cursor: string | null }>(list.GET, "/api/orders?limit=1", { expect: 200 });
    expect(first.body.counts.fulfilled).toBe(1);
    const un = await import("@/app/api/orders/[id]/unfulfil/route");
    const r = await api<{ order: { status: string; fulfilled_at: string | null } }>(un.POST, `/api/orders/${id}/unfulfil`, { method: "POST", params: { id }, expect: 200 });
    expect(r.body.order.status).toBe("paid");
    expect(r.body.order.fulfilled_at).toBeNull();
    const row = await sqlOne<{ type: string }>(`SELECT type FROM events WHERE user_id = $1 AND type = 'order.unfulfilled' LIMIT 1`, [org.dataId]);
    expect(row?.type).toBe("order.unfulfilled");
  });

  it("projects: status=open server filter", async () => {
    const route = await import("@/app/api/projects/route");
    for (const [name, status] of [["Open A", "active"], ["Open B", "planning"], ["Closed", "done"]] as const) {
      await api(route.POST, "/api/projects", { json: { name, status }, expect: 201 });
    }
    const r = await api<{ projects: Array<{ name: string }> }>(route.GET, "/api/projects?status=open", { expect: 200 });
    expect(r.body.projects.map((p) => p.name).sort()).toEqual(["Open A", "Open B"]);
  });

  it("marketing lists paginate; sequences include audience_name", async () => {
    const aud = await import("@/app/api/marketing/audiences/route");
    const seq = await import("@/app/api/marketing/sequences/route");
    const a = await api<{ audience: { id: string } }>(aud.POST, "/api/marketing/audiences", { json: { name: "VIPs", definition: {} }, expect: 201 });
    await api(aud.POST, "/api/marketing/audiences", { json: { name: "Others", definition: {} }, expect: 201 });
    const p1 = await api<{ audiences: Array<{ name: string }>; next_cursor: string | null }>(aud.GET, "/api/marketing/audiences?limit=1", { expect: 200 });
    expect(p1.body.audiences).toHaveLength(1);
    expect(p1.body.next_cursor).toBeTruthy();
    const p2 = await api<{ audiences: Array<{ name: string }>; next_cursor: string | null }>(aud.GET, `/api/marketing/audiences?limit=1&cursor=${encodeURIComponent(p1.body.next_cursor!)}`, { expect: 200 });
    expect(p2.body.audiences).toHaveLength(1);
    expect(p2.body.audiences[0].name).not.toBe(p1.body.audiences[0].name);
    await api(seq.POST, "/api/marketing/sequences", { json: { name: "Join", trigger: "audience_join", trigger_config: { audience_id: a.body.audience.id }, steps: [{ delay_hours: 0, channel: "email", subject: "Hi", body_md: "Hello" }] }, expect: 201 });
    const s = await api<{ sequences: Array<{ name: string; audience_name: string | null }> }>(seq.GET, "/api/marketing/sequences", { expect: 200 });
    expect(s.body.sequences.find((x) => x.name === "Join")?.audience_name).toBe("VIPs");
  });

  it("a step already marked sent is never re-sent", async () => {
    const contacts = await import("@/app/api/crm/contacts/route");
    const c = await api<{ contact: { id: string } }>(contacts.POST, "/api/crm/contacts", { json: { full_name: "Dup Test", email: `dup-${org.slug}@example.test`, lifecycle: "customer" }, expect: 201 });
    const seqRoute = await import("@/app/api/marketing/sequences/route");
    const s = await api<{ sequence: { id: string } }>(seqRoute.POST, "/api/marketing/sequences", { json: { name: "Once", trigger: "manual", steps: [{ delay_hours: 0, channel: "email", subject: "Once only", body_md: "Body" }, { delay_hours: 24, channel: "email", subject: "Second", body_md: "Body 2" }] }, expect: 201 });
    const enroll = await import("@/app/api/marketing/sequences/[id]/enroll/route");
    await api(enroll.POST, `/api/marketing/sequences/${s.body.sequence.id}/enroll`, { json: { contact_ids: [c.body.contact.id] }, params: { id: s.body.sequence.id }, expect: 200 });
    // Simulate a crash after the send but before advancing: step 0 marked sent, still due at step 0.
    await sql(`UPDATE sequence_enrollments SET last_step_sent_index = 0, last_step_sent_at = NOW(), next_at = NOW() - interval '1 minute' WHERE sequence_id = $1`, [s.body.sequence.id]);
    const { runDueEnrollments } = await import("@/lib/marketing/sequences");
    const r = await runDueEnrollments(50);
    expect(r.skippedDuplicate).toBeGreaterThanOrEqual(1);
    const mails = await sql(`SELECT id FROM notification_outbox WHERE user_id = $1 AND subject = 'Once only'`, [org.dataId]);
    expect(mails).toHaveLength(0);
    const e = await sqlOne<{ step_index: number; status: string }>(`SELECT step_index, status FROM sequence_enrollments WHERE sequence_id = $1`, [s.body.sequence.id]);
    expect(e).toMatchObject({ step_index: 1, status: "active" });
  });
});
