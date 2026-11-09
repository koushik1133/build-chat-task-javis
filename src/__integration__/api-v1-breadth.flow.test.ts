/**
 * Phase 6 lane B: API v1 breadth + copilot grounding.
 *
 * API key with scopes → expenses (event emitted) → timers → equipment
 * checkout/checkin → change order accepted → SLA policy → KB create/publish/
 * search → consents → DSR → voice campaign + targets → agents/approvals →
 * single event → 403 on the wrong scope → copilot plan for /helpdesk?ticket=
 * and /r/<type> with a mocked LLM.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import type { LlmTurnResult, RouterMessage } from "@/lib/agents/types";
import { api, cleanupDataIds, createTestOrg, describeDb, expectEvent, setScope, sql, type TestOrg } from "./setup";

vi.mock("@/lib/auth/scope", () => import("./setup").then((m) => m.scopeMockFactory()));
vi.mock("@/lib/supabase/server", () => import("./setup").then((m) => m.supabaseMockFactory()));

/** Mocked LLM: records the messages it was given and replies with text (no tool calls). */
const llmCalls: RouterMessage[][] = [];
vi.mock("@/lib/llm/router", async () => {
  const actual = await vi.importActual<typeof import("@/lib/llm/router")>("@/lib/llm/router");
  return {
    ...actual,
    completeWithTools: async (messages: RouterMessage[]): Promise<LlmTurnResult> => {
      llmCalls.push(messages);
      return { content: "Mocked copilot answer.", toolCalls: [], provider: "mock", model: "mock-1", promptTokens: 10, completionTokens: 5, finishReason: "stop" };
    },
  };
});
vi.mock("@/lib/llm/budgets", () => ({
  assertBudget: async () => ({ capMicros: null, hardStop: false, allowlist: null, spentMicros: 0, creditsEnforced: false }),
}));
vi.mock("@/lib/llm/metering", () => ({ recordUsage: async () => 0 }));

interface ApiErr { error: { code: string; message: string; details?: unknown } }
type Env<T> = { data: T; meta: { next_cursor: string | null } };

describeDb("api v1 breadth flow", () => {
  let org: TestOrg;
  let fullKey: string;
  let crmOnlyKey: string;
  const bearer = (key: string) => ({ authorization: `Bearer ${key}` });

  beforeAll(async () => {
    org = await createTestOrg("api-v1-breadth");
    setScope(org);
    const keys = await import("@/app/api/api-keys/route");
    const full = await api<{ key: string }>(keys.POST, "/api/api-keys", {
      json: { name: "breadth full", scopes: ["write:crm", "write:billing", "write:helpdesk", "write:knowledge", "write:agents", "write:messaging", "write:settings", "read:reports"] },
      expect: 201,
    });
    fullKey = full.body.key;
    const ro = await api<{ key: string }>(keys.POST, "/api/api-keys", { json: { name: "breadth crm", scopes: ["read:crm"] }, expect: 201 });
    crmOnlyKey = ro.body.key;
  });
  afterAll(async () => {
    await cleanupDataIds([org.dataId]);
  });

  it("expenses: create emits expense.created, list/get/patch/delete round-trip", async () => {
    const route = await import("@/app/api/v1/expenses/route");
    const byId = await import("@/app/api/v1/expenses/[id]/route");
    const created = await api<Env<{ id: string; total_minor: number; category: string }>>(route.POST, "/api/v1/expenses", {
      json: { category: "fuel", vendor: "Shell", amount_minor: 5000, tax_minor: 500, billable: true }, headers: bearer(fullKey), expect: 201,
    });
    expect(created.body.data.total_minor).toBe(5500);
    await expectEvent(org.dataId, "expense.created", created.body.data.id);
    const list = await api<Env<Array<{ id: string }>>>(route.GET, "/api/v1/expenses", { query: { unbilled: "true", category: "fuel" }, headers: bearer(fullKey), expect: 200 });
    expect(list.body.data.map((e) => e.id)).toContain(created.body.data.id);
    const patched = await api<Env<{ vendor: string }>>(byId.PATCH, `/api/v1/expenses/${created.body.data.id}`, { method: "PATCH", json: { vendor: "BP" }, params: { id: created.body.data.id }, headers: bearer(fullKey), expect: 200 });
    expect(patched.body.data.vendor).toBe("BP");
    await api(byId.DELETE, `/api/v1/expenses/${created.body.data.id}`, { method: "DELETE", params: { id: created.body.data.id }, headers: bearer(fullKey), expect: 200 });
    await api(byId.GET, `/api/v1/expenses/${created.body.data.id}`, { params: { id: created.body.data.id }, headers: bearer(fullKey), expect: 404 });
  });

  it("time entries: start a timer, list running, stop it", async () => {
    const start = await import("@/app/api/v1/time-entries/start/route");
    const stop = await import("@/app/api/v1/time-entries/[id]/stop/route");
    const list = await import("@/app/api/v1/time-entries/route");
    const t = await api<Env<{ id: string; running: boolean }>>(start.POST, "/api/v1/time-entries/start", { json: { description: "Site visit", rate_minor: 12000 }, headers: bearer(fullKey), expect: 201 });
    expect(t.body.data.running).toBe(true);
    const running = await api<Env<Array<{ id: string }>>>(list.GET, "/api/v1/time-entries", { query: { running: "true" }, headers: bearer(fullKey), expect: 200 });
    expect(running.body.data.map((e) => e.id)).toContain(t.body.data.id);
    const ended = new Date(Date.now() + 30 * 60_000).toISOString();
    const stopped = await api<Env<{ running: boolean; minutes: number; value_minor: number }>>(stop.POST, `/api/v1/time-entries/${t.body.data.id}/stop`, { json: { ended_at: ended }, params: { id: t.body.data.id }, headers: bearer(fullKey), expect: 200 });
    expect(stopped.body.data.running).toBe(false);
    expect(stopped.body.data.minutes).toBeGreaterThanOrEqual(30);
    expect(stopped.body.data.value_minor).toBeGreaterThan(0);
  });

  it("equipment: checkout reserves tracked stock, checkin releases it", async () => {
    const products = await import("@/app/api/v1/products/route");
    const p = await api<Env<{ id: string }>>(products.POST, "/api/v1/products", { json: { name: "Laser level", kind: "rental", track_stock: true, stock_on_hand: 3 }, headers: bearer(fullKey), expect: 201 });
    const checkout = await import("@/app/api/v1/equipment/checkout/route");
    const checkin = await import("@/app/api/v1/equipment/[id]/checkin/route");
    const list = await import("@/app/api/v1/equipment/route");
    const out = await api<Env<{ id: string; qty: number; overdue: boolean }>>(checkout.POST, "/api/v1/equipment/checkout", { json: { product_id: p.body.data.id, qty: 2, checked_out_to: "Crew A" }, headers: bearer(fullKey), expect: 201 });
    expect(out.body.data.qty).toBe(2);
    const reserved = await sql<{ stock_reserved: number }>(`SELECT stock_reserved FROM products WHERE id = $1`, [p.body.data.id]);
    expect(Number(reserved[0].stock_reserved)).toBe(2);
    const open = await api<Env<Array<{ id: string }>>>(list.GET, "/api/v1/equipment", { query: { open: "true" }, headers: bearer(fullKey), expect: 200 });
    expect(open.body.data.map((c) => c.id)).toContain(out.body.data.id);
    const back = await api<Env<{ returned_at: string | null }>>(checkin.POST, `/api/v1/equipment/${out.body.data.id}/checkin`, { method: "POST", params: { id: out.body.data.id }, headers: bearer(fullKey), expect: 200 });
    expect(back.body.data.returned_at).toBeTruthy();
    // Too much → 422 (insufficient stock surfaces as unprocessable).
    await api(checkout.POST, "/api/v1/equipment/checkout", { json: { product_id: p.body.data.id, qty: 99 }, headers: bearer(fullKey), expect: 422 });
  });

  it("change orders: create then accept bills a draft invoice", async () => {
    const route = await import("@/app/api/v1/change-orders/route");
    const status = await import("@/app/api/v1/change-orders/[id]/status/route");
    const co = await api<Env<{ id: string; label: string; delta_minor: number; status: string }>>(route.POST, "/api/v1/change-orders", {
      json: { title: "Extra outlet", items: [{ description: "Outlet", qty: 2, unit_minor: 7500 }] }, headers: bearer(fullKey), expect: 201,
    });
    expect(co.body.data.label).toMatch(/^CO-\d{4}$/);
    expect(co.body.data.delta_minor).toBe(15000);
    const accepted = await api<Env<{ change_order: { status: string }; invoice: { id: string; status: string } | null }>>(status.POST, `/api/v1/change-orders/${co.body.data.id}/status`, {
      json: { status: "accepted" }, params: { id: co.body.data.id }, headers: bearer(fullKey), expect: 200,
    });
    expect(accepted.body.data.change_order.status).toBe("accepted");
    expect(accepted.body.data.invoice?.id).toBeTruthy();
    // Frozen once accepted.
    await api(status.POST, `/api/v1/change-orders/${co.body.data.id}/status`, { json: { status: "draft" }, params: { id: co.body.data.id }, headers: bearer(fullKey), expect: 422 });
  });

  it("sla policies: create + patch, 403 with the wrong scope", async () => {
    const route = await import("@/app/api/v1/sla-policies/route");
    const byId = await import("@/app/api/v1/sla-policies/[id]/route");
    const forbidden = await api<ApiErr>(route.POST, "/api/v1/sla-policies", { json: { name: "x" }, headers: bearer(crmOnlyKey), expect: 403 });
    expect(forbidden.body.error.code).toBe("forbidden");
    expect((forbidden.body.error.details as { required: string }).required).toBe("write:helpdesk");
    const p = await api<Env<{ id: string; first_response_minutes: number; priority_overrides: unknown }>>(route.POST, "/api/v1/sla-policies", {
      json: { name: "Gold", first_response_minutes: 30, resolution_minutes: 480, priority_overrides: { urgent: { first: 10 } } }, headers: bearer(fullKey), expect: 201,
    });
    expect(p.body.data.first_response_minutes).toBe(30);
    expect(p.body.data.priority_overrides).toEqual({ urgent: { first: 10 } });
    const patched = await api<Env<{ name: string }>>(byId.PATCH, `/api/v1/sla-policies/${p.body.data.id}`, { method: "PATCH", json: { name: "Gold+" }, params: { id: p.body.data.id }, headers: bearer(fullKey), expect: 200 });
    expect(patched.body.data.name).toBe("Gold+");
  });

  it("knowledge base: create draft, publish, search finds it; crm-only key gets 403", async () => {
    const route = await import("@/app/api/v1/kb/articles/route");
    const publish = await import("@/app/api/v1/kb/articles/[id]/publish/route");
    const search = await import("@/app/api/v1/kb/search/route");
    await api(route.GET, "/api/v1/kb/articles", { headers: bearer(crmOnlyKey), expect: 403 });
    const a = await api<Env<{ id: string; status: string; slug: string }>>(route.POST, "/api/v1/kb/articles", {
      json: { title: "Resetting the thermostat", body_md: "# Steps\n\n1. Hold the button for 10 seconds." }, headers: bearer(fullKey), expect: 201,
    });
    expect(a.body.data.status).toBe("draft");
    const pub = await api<Env<{ status: string; published_at: string | null }>>(publish.POST, `/api/v1/kb/articles/${a.body.data.id}/publish`, { method: "POST", params: { id: a.body.data.id }, headers: bearer(fullKey), expect: 200 });
    expect(pub.body.data.status).toBe("published");
    const hits = await api<Env<Array<{ id: string; score: number }>>>(search.GET, "/api/v1/kb/search", { query: { q: "thermostat" }, headers: bearer(fullKey), expect: 200 });
    expect(hits.body.data.map((h) => h.id)).toContain(a.body.data.id);
    await api(search.GET, "/api/v1/kb/search", { headers: bearer(fullKey), expect: 422 }); // q required
  });

  it("privacy: record → withdraw consent, consent state reflects the latest row; DSR opens for a contact", async () => {
    const contacts = await import("@/app/api/v1/contacts/route");
    const c = await api<Env<{ id: string }>>(contacts.POST, "/api/v1/contacts", { json: { full_name: "Grace Hopper", email: `grace-${randomUUID().slice(0, 6)}@example.test` }, headers: bearer(fullKey), expect: 201 });
    const consents = await import("@/app/api/v1/privacy/consents/route");
    const withdraw = await import("@/app/api/v1/privacy/consents/withdraw/route");
    const granted = await api<Env<{ status: string; source: string }>>(consents.POST, "/api/v1/privacy/consents", { json: { subject_id: c.body.data.id, purpose: "marketing_email", text: "Newsletter opt-in" }, headers: bearer(fullKey), expect: 201 });
    expect(granted.body.data).toMatchObject({ status: "granted", source: "api" });
    await api(withdraw.POST, "/api/v1/privacy/consents/withdraw", { json: { subject_id: c.body.data.id, purpose: "marketing_email" }, headers: bearer(fullKey), expect: 201 });
    const state = await api<Env<{ current: Record<string, { status: string }>; history: unknown[] }>>(consents.GET, "/api/v1/privacy/consents", { query: { subject_id: c.body.data.id }, headers: bearer(fullKey), expect: 200 });
    expect(state.body.data.current.marketing_email.status).toBe("withdrawn");
    expect(state.body.data.history).toHaveLength(2);

    const dsr = await import("@/app/api/v1/privacy/dsr/route");
    await api(dsr.POST, "/api/v1/privacy/dsr", { json: { subject_id: c.body.data.id, kind: "access" }, headers: bearer(crmOnlyKey), expect: 403 });
    const opened = await api<Env<{ id: string; status: string; kind: string; due_at: string }>>(dsr.POST, "/api/v1/privacy/dsr", { json: { subject_id: c.body.data.id, kind: "access", notes: "via API" }, headers: bearer(fullKey), expect: 201 });
    expect(opened.body.data).toMatchObject({ status: "received", kind: "access" });
    const list = await api<Env<Array<{ id: string }>>>(dsr.GET, "/api/v1/privacy/dsr", { query: { status: "open" }, headers: bearer(fullKey), expect: 200 });
    expect(list.body.data.map((r) => r.id)).toContain(opened.body.data.id);
    await api(dsr.POST, "/api/v1/privacy/dsr", { json: { subject_id: randomUUID(), kind: "access" }, headers: bearer(fullKey), expect: 404 });
  });

  it("voice: create a draft campaign, add ad-hoc targets, start, pause; invalid transition → 409", async () => {
    const route = await import("@/app/api/v1/voice/campaigns/route");
    const targets = await import("@/app/api/v1/voice/campaigns/[id]/targets/route");
    const start = await import("@/app/api/v1/voice/campaigns/[id]/start/route");
    const pause = await import("@/app/api/v1/voice/campaigns/[id]/pause/route");
    const byId = await import("@/app/api/v1/voice/campaigns/[id]/route");
    const c = await api<Env<{ id: string; status: string; window_start: string }>>(route.POST, "/api/v1/voice/campaigns", {
      json: { name: "Spring check-ups", script: "Hi {{first_name}}, time for your service.", timezone: "America/New_York", require_consent: false }, headers: bearer(fullKey), expect: 201,
    });
    expect(c.body.data).toMatchObject({ status: "draft", window_start: "09:00" });
    const added = await api<Env<{ added: number; skipped_dnc: number }>>(targets.POST, `/api/v1/voice/campaigns/${c.body.data.id}/targets`, {
      json: { phones: [{ phone: "+15555550101", first_name: "Ada" }, { phone: "+15555550102" }] }, params: { id: c.body.data.id }, headers: bearer(fullKey), expect: 201,
    });
    expect(added.body.data.added).toBe(2);
    const detail = await api<Env<{ stats: { total: number; queued: number } }>>(byId.GET, `/api/v1/voice/campaigns/${c.body.data.id}`, { params: { id: c.body.data.id }, headers: bearer(fullKey), expect: 200 });
    expect(detail.body.data.stats.total).toBe(2);
    // draft → paused is not a legal transition.
    await api(pause.POST, `/api/v1/voice/campaigns/${c.body.data.id}/pause`, { method: "POST", params: { id: c.body.data.id }, headers: bearer(fullKey), expect: 409 });
    const running = await api<Env<{ status: string }>>(start.POST, `/api/v1/voice/campaigns/${c.body.data.id}/start`, { method: "POST", params: { id: c.body.data.id }, headers: bearer(fullKey), expect: 200 });
    expect(running.body.data.status).toBe("running");
    const paused = await api<Env<{ status: string }>>(pause.POST, `/api/v1/voice/campaigns/${c.body.data.id}/pause`, { method: "POST", params: { id: c.body.data.id }, headers: bearer(fullKey), expect: 200 });
    expect(paused.body.data.status).toBe("paused");
  });

  it("agents + approvals: list, queue a run, approve an MCP-style approval inline", async () => {
    const agentId = randomUUID();
    await sql(`INSERT INTO agents (id, user_id, name, role, status, autonomy_level, tools) VALUES ($1::uuid, $2, 'Breadth bot', 'Ops', 'idle', 'approve', $3)`, [agentId, org.dataId, JSON.stringify(["tasks.list"])]);
    const agents = await import("@/app/api/v1/agents/route");
    const runs = await import("@/app/api/v1/agents/[id]/runs/route");
    const runList = await import("@/app/api/v1/agents/runs/route");
    const list = await api<Env<Array<{ id: string; tools: string[] | null }>>>(agents.GET, "/api/v1/agents", { headers: bearer(fullKey), expect: 200 });
    expect(list.body.data.find((a) => a.id === agentId)?.tools).toEqual(["tasks.list"]);
    const queued = await api<Env<{ run_id: string; status: string }>>(runs.POST, `/api/v1/agents/${agentId}/runs`, { json: { prompt: "Summarise open tasks" }, params: { id: agentId }, headers: bearer(fullKey), expect: 201 });
    expect(queued.body.data.status).toBe("queued");
    const mine = await api<Env<Array<{ id: string; agent_name: string | null }>>>(runList.GET, "/api/v1/agents/runs", { query: { agent_id: agentId }, headers: bearer(fullKey), expect: 200 });
    expect(mine.body.data.map((r) => r.id)).toContain(queued.body.data.run_id);
    expect(mine.body.data[0].agent_name).toBe("Breadth bot");

    // A copilot/MCP approval (no run) executes inline when approved.
    const approvalId = randomUUID();
    await sql(`INSERT INTO approvals (id, user_id, run_id, agent_id, tool_name, input, preview, status) VALUES ($1, $2, 'mcp', NULL, 'tasks.create', $3, 'Create task', 'pending')`, [approvalId, org.dataId, JSON.stringify({ title: "Approved via API" })]);
    const approvals = await import("@/app/api/v1/approvals/route");
    const decide = await import("@/app/api/v1/approvals/[id]/decide/route");
    const pending = await api<Env<Array<{ id: string; input: Record<string, unknown> }>>>(approvals.GET, "/api/v1/approvals", { query: { status: "pending" }, headers: bearer(fullKey), expect: 200 });
    expect(pending.body.data.find((a) => a.id === approvalId)?.input).toEqual({ title: "Approved via API" });
    // write:agents alone cannot approve (= execute) a tool from another area: the "full" key has no write:tasks.
    const refused = await api<{ error: { code: string } }>(decide.POST, `/api/v1/approvals/${approvalId}/decide`, { json: { decision: "approved" }, params: { id: approvalId }, headers: bearer(fullKey), expect: 403 });
    expect(refused.body.error.code).toBe("forbidden");
    expect(await sql(`SELECT status FROM approvals WHERE id = $1`, [approvalId])).toEqual([{ status: "pending" }]);
    expect(await sql(`SELECT id FROM tasks WHERE user_id = $1 AND title = 'Approved via API'`, [org.dataId])).toHaveLength(0);
    const keys = await import("@/app/api/api-keys/route");
    const tasksKey = await api<{ key: string }>(keys.POST, "/api/api-keys", { json: { name: "breadth agents+tasks", scopes: ["write:agents", "write:tasks"] }, expect: 201 });
    const decided = await api<Env<{ status: string; outcome: string | null }>>(decide.POST, `/api/v1/approvals/${approvalId}/decide`, { json: { decision: "approved" }, params: { id: approvalId }, headers: bearer(tasksKey.body.key), expect: 200 });
    expect(decided.body.data.status).toBe("approved");
    expect(decided.body.data.outcome).toMatch(/^Done/);
    expect(await sql(`SELECT id FROM tasks WHERE user_id = $1 AND title = 'Approved via API'`, [org.dataId])).toHaveLength(1);
    await api(decide.POST, `/api/v1/approvals/${approvalId}/decide`, { json: { decision: "rejected" }, params: { id: approvalId }, headers: bearer(fullKey), expect: 409 });
  });

  it("events/{id}, credits, marketplace and optimize answer under their scopes", async () => {
    const events = await import("@/app/api/v1/events/route");
    const event = await import("@/app/api/v1/events/[id]/route");
    const list = await api<Env<Array<{ id: string; type: string }>>>(events.GET, "/api/v1/events", { query: { type: "expense.created" }, headers: bearer(fullKey), expect: 200 });
    expect(list.body.data.length).toBeGreaterThan(0);
    const one = await api<Env<{ id: string; type: string; data: Record<string, unknown> }>>(event.GET, `/api/v1/events/${list.body.data[0].id}`, { params: { id: list.body.data[0].id }, headers: bearer(fullKey), expect: 200 });
    expect(one.body.data.type).toBe("expense.created");
    expect(one.body.data.data.total_minor).toBe(5500);

    const balance = await import("@/app/api/v1/credits/balance/route");
    const b = await api<Env<{ balance: number }>>(balance.GET, "/api/v1/credits/balance", { headers: bearer(fullKey), expect: 200 });
    expect(typeof b.body.data.balance).toBe("number");

    const marketplace = await import("@/app/api/v1/marketplace/route");
    const m = await api<Env<Array<{ id: string; kind: string }>>>(marketplace.GET, "/api/v1/marketplace", { query: { kind: "agent" }, headers: bearer(fullKey), expect: 200 });
    expect(m.body.data.every((l) => l.kind === "agent")).toBe(true);
    await api(marketplace.GET, "/api/v1/marketplace", { headers: bearer(crmOnlyKey), expect: 403 });

    const cashflow = await import("@/app/api/v1/optimize/cashflow/route");
    const cf = await api<Env<Record<string, unknown>>>(cashflow.GET, "/api/v1/optimize/cashflow", { query: { weeks: 4 }, headers: bearer(fullKey), expect: 200 });
    expect(cf.body.data.currency).toBeDefined();
  });

  it("copilot: /helpdesk?ticket=<id> grounds on the ticket with helpdesk tools; /r/<type> uses copilot_prompt", async () => {
    const tickets = await import("@/app/api/v1/tickets/route");
    const t = await api<Env<{ id: string; number: number }>>(tickets.POST, "/api/v1/tickets", { json: { subject: "Thermostat stuck", body: "It shows E4.", priority: "high" }, headers: bearer(fullKey), expect: 201 });
    const types = await import("@/app/api/v1/record-types/route");
    const rt = await api<Env<{ id: string; slug: string }>>(types.POST, "/api/v1/record-types", {
      json: { name: "Service Jobs", slug: "service-jobs", fields: [{ key: "site", label: "Site", type: "text" }], stages: [{ key: "new", label: "New" }, { key: "done", label: "Done" }], copilot_prompt: "Always ask for the site address before scheduling." },
      headers: bearer(fullKey), expect: 201,
    });

    const { planCopilot } = await import("@/lib/copilot/copilot");
    const { pageContextFrom } = await import("@/lib/copilot/modules");

    const hp = pageContextFrom("/helpdesk", `?ticket=${t.body.data.id}`);
    expect(hp.params).toEqual({ ticket: t.body.data.id });
    const plan = await planCopilot(org.dataId, { module: "helpdesk", page: hp });
    const names = plan.tools.map((x) => x.name);
    expect(names).toEqual(expect.arrayContaining(["helpdesk.get_ticket", "helpdesk.reply", "helpdesk.create_ticket", "helpdesk.set_sla", "kb.search", "crm.get_contact"]));
    expect(names).not.toContain("voice.start_campaign");
    expect(names).not.toContain("social.publish_post");
    expect(plan.entityHints.join(" ")).toContain("helpdesk.get_ticket");
    expect(plan.system).toContain("Thermostat stuck");
    expect(plan.system).toContain("SLA");

    const rp = pageContextFrom("/r/service-jobs", "");
    expect(rp.recordType).toBe("service-jobs");
    const recPlan = await planCopilot(org.dataId, { module: "records", page: rp });
    expect(recPlan.recordTypePrompt).toBe("Always ask for the site address before scheduling.");
    expect(recPlan.system).toContain("Instructions for this record type");
    expect(recPlan.system).toContain("Service Jobs");
    expect(recPlan.tools.map((x) => x.name)).toEqual(expect.arrayContaining(["records.search", "records.create", "records.delete", "records.link"]));

    // The route accepts the page context and the (mocked) model sees the grounded system prompt.
    const copilot = await import("@/app/api/copilot/route");
    llmCalls.length = 0;
    const res = await api<{ text: string; toolCalls: unknown[] }>(copilot.POST, "/api/copilot", {
      json: { module: "helpdesk", message: "What is this ticket about?", page: { pathname: "/helpdesk", params: { ticket: t.body.data.id, bogus: "x" } } }, expect: 200,
    });
    expect(res.body.text).toBe("Mocked copilot answer.");
    expect(llmCalls).toHaveLength(1);
    const system = llmCalls[0][0];
    expect(system.role).toBe("system");
    expect((system as { content: string }).content).toContain(`ticket ${t.body.data.id}`);
    expect((system as { content: string }).content).toContain("Thermostat stuck");
    await api(copilot.POST, "/api/copilot", { json: { module: "nope", message: "x" }, expect: 400 });
    void rt;
  });
});
