/**
 * Phase 7 lane C: automations v2.
 *
 * install template → enable → real ticket.created via lib → fanOutEvents →
 * runQueued → task created + run done → idempotent on a second fan-out →
 * approve-gated automation → waiting + approvals row → decide → resumes →
 * contact created → dry-run plan → retry → inbound webhook trigger → legacy
 * adapter + migration → API v1 list/get/disable/runs.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { api, cleanupDataIds, createTestOrg, describeDb, expectEvent, setScope, sql, sqlOne, type TestOrg } from "./setup";

vi.mock("@/lib/auth/scope", () => import("./setup").then((m) => m.scopeMockFactory()));
vi.mock("@/lib/supabase/server", () => import("./setup").then((m) => m.supabaseMockFactory()));

interface AutomationDTO {
  id: string;
  name: string;
  enabled: boolean;
  legacy: boolean;
  autonomy: string;
  trigger_type: string;
  trigger_config: { event_type?: string; webhook?: { token: string } };
  steps: Array<{ id: string; kind: string; config: Record<string, unknown> }>;
  run_count: number;
}
interface RunDTO {
  id: string;
  status: string;
  attempt: number;
  approval_id: string | null;
  error: string | null;
  step_results: Array<{ step_id: string; status: string; summary: string }>;
}
type Env<T> = { data: T; meta: { next_cursor: string | null } };

/** Park the global fan-out cursor at "now" so earlier events in the shared local DB are not replayed. */
async function resetCursor(): Promise<void> {
  await sql(`DELETE FROM automation_cursors WHERE name = 'events'`);
  await sql(`INSERT INTO automation_cursors (name, last_event_at, last_event_id, updated_at) VALUES ('events', NOW(), '', NOW())`);
}

describeDb("automations v2 flow", () => {
  let org: TestOrg;

  beforeAll(async () => {
    org = await createTestOrg("automations");
    setScope(org);
  });
  afterAll(async () => {
    await cleanupDataIds([org.dataId]);
  });

  it("catalog lists events with samples, tools with schemas and condition ops", async () => {
    const route = await import("@/app/api/automations/catalog/route");
    const r = await api<{ events: Array<{ type: string; sample: { data: unknown } }>; tools: Array<{ name: string; schema: { type: string } }>; condition_ops: unknown[] }>(route.GET, "/api/automations/catalog", { expect: 200 });
    expect(r.body.events.find((e) => e.type === "ticket.created")?.sample.data).toMatchObject({ number: 17 });
    expect(r.body.tools.find((t) => t.name === "tasks.create")?.schema.type).toBe("object");
    expect(r.body.condition_ops.length).toBe(10);
  });

  it("template install → enable → real ticket event → fan-out → run → task created; second fan-out is idempotent", async () => {
    await resetCursor();
    const templates = await import("@/app/api/automations/templates/route");
    const installed = await api<{ automation: AutomationDTO }>(templates.POST, "/api/automations/templates", { json: { key: "new-ticket-ack" }, expect: 201 });
    const autoId = installed.body.automation.id;
    expect(installed.body.automation.enabled).toBe(false);
    expect(installed.body.automation.autonomy).toBe("auto");

    const byId = await import("@/app/api/automations/[id]/route");
    const enabled = await api<{ automation: AutomationDTO }>(byId.PATCH, `/api/automations/${autoId}`, { method: "PATCH", json: { enabled: true }, params: { id: autoId }, expect: 200 });
    expect(enabled.body.automation.enabled).toBe(true);

    const { createTicket } = await import("@/lib/helpdesk/tickets");
    const ticket = await createTicket(org.dataId, { subject: "Server down", body: "Everything is on fire", priority: "urgent", source: "manual", requester_email: "ada@example.com" });
    await expectEvent(org.dataId, "ticket.created", ticket.id);

    const { fanOutEvents } = await import("@/lib/automations/triggers");
    const { runQueued } = await import("@/lib/automations/engine");
    const fan = await fanOutEvents(200);
    expect(fan.queued).toBeGreaterThanOrEqual(1);
    const queued = await sql<{ id: string; status: string }>(`SELECT id, status FROM automation_runs WHERE user_id = $1 AND automation_id = $2`, [org.dataId, autoId]);
    expect(queued).toHaveLength(1);
    expect(queued[0].status).toBe("queued");

    const ran = await runQueued(50);
    expect(ran.done).toBeGreaterThanOrEqual(1);
    const run = await sqlOne<{ status: string; step_results: string; error: string | null }>(`SELECT status, step_results, error FROM automation_runs WHERE id = $1`, [queued[0].id]);
    expect(run?.error).toBeNull();
    expect(run?.status).toBe("done");
    const steps = JSON.parse(run!.step_results) as Array<{ step_id: string; status: string }>;
    expect(steps.map((s) => `${s.step_id}:${s.status}`)).toEqual(["task:ok", "notify:ok"]);

    const tasks = await sql<{ title: string }>(`SELECT title FROM tasks WHERE user_id = $1 ORDER BY created_at DESC`, [org.dataId]);
    expect(tasks[0]?.title).toBe(`Triage ticket #${ticket.number}: Server down`);
    const outbox = await sql<{ channel: string; subject: string }>(`SELECT channel, subject FROM notification_outbox WHERE user_id = $1 AND channel = 'in_app' ORDER BY created_at DESC`, [org.dataId]);
    expect(outbox.some((o) => o.subject === `Urgent ticket #${ticket.number}`)).toBe(true);
    await expectEvent(org.dataId, "automation.run_finished", queued[0].id);

    // Stats on the automation row + list endpoint.
    const list = await import("@/app/api/automations/route");
    const listed = await api<{ automations: Array<AutomationDTO & { stats: { total: number } }> }>(list.GET, "/api/automations", { expect: 200 });
    const mine = listed.body.automations.find((a) => a.id === autoId)!;
    expect(mine.run_count).toBe(1);
    expect(mine.stats.total).toBe(1);

    // Idempotency: rewind the cursor and fan out again — no second run for the same (automation, event).
    await sql(`UPDATE automation_cursors SET last_event_at = NOW() - INTERVAL '1 hour', last_event_id = '' WHERE name = 'events'`);
    await fanOutEvents(500);
    const again = await sql<{ id: string }>(`SELECT id FROM automation_runs WHERE user_id = $1 AND automation_id = $2`, [org.dataId, autoId]);
    expect(again).toHaveLength(1);

    // Runs endpoint + run detail.
    const runs = await import("@/app/api/automations/[id]/runs/route");
    const rl = await api<{ runs: RunDTO[] }>(runs.GET, `/api/automations/${autoId}/runs`, { params: { id: autoId }, expect: 200 });
    expect(rl.body.runs[0].status).toBe("done");
    const runRoute = await import("@/app/api/automations/runs/[runId]/route");
    const detail = await api<{ run: RunDTO }>(runRoute.GET, `/api/automations/runs/${queued[0].id}`, { params: { runId: queued[0].id }, expect: 200 });
    expect(detail.body.run.step_results).toHaveLength(2);

    // Retry re-executes from the first step: attempt 2, a second task.
    const retried = await api<{ run: RunDTO }>(runRoute.POST, `/api/automations/runs/${queued[0].id}`, { method: "POST", params: { runId: queued[0].id }, expect: 200 });
    expect(retried.body.run.attempt).toBe(2);
    expect(retried.body.run.status).toBe("done");
    const tasks2 = await sql<{ title: string }>(`SELECT title FROM tasks WHERE user_id = $1`, [org.dataId]);
    expect(tasks2.filter((t) => t.title.startsWith("Triage ticket")).length).toBe(2);
  });

  it("approve-gated automation: waiting + approvals row → decide → resumes and finishes", async () => {
    await resetCursor();
    const list = await import("@/app/api/automations/route");
    const created = await api<{ automation: AutomationDTO }>(list.POST, "/api/automations", {
      json: {
        name: "Ticket → internal note (gated)",
        trigger_type: "event",
        trigger_config: { event_type: "ticket.*" },
        conditions: { all: [{ field: "event.data.requester_email", op: "exists" }] },
        steps: [
          { id: "reply", kind: "tool", config: { tool: "helpdesk.reply", input: { ticketId: "{{event.entity_id}}", body: "Triage note for {{event.data.requester_email}}", is_internal: true } } },
          { id: "note", kind: "notify", config: { channel: "in_app", to: "{{org.id}}", subject: "Replied", body: "{{steps.reply.id}}" } },
        ],
        autonomy: "approve",
        enabled: true,
      },
      expect: 201,
    });
    const autoId = created.body.automation.id;

    const { createTicket } = await import("@/lib/helpdesk/tickets");
    const ticket = await createTicket(org.dataId, { subject: "Needs a contact", priority: "low", source: "manual", requester_email: "grace@example.com" });
    await expectEvent(org.dataId, "ticket.created", ticket.id);

    const { fanOutEvents } = await import("@/lib/automations/triggers");
    const { runQueued } = await import("@/lib/automations/engine");
    await fanOutEvents(200);
    const ran = await runQueued(50);
    expect(ran.waiting).toBeGreaterThanOrEqual(1);
    const run = await sqlOne<{ id: string; status: string; approval_id: string | null; step_index: number }>(`SELECT id, status, approval_id, step_index FROM automation_runs WHERE user_id = $1 AND automation_id = $2`, [org.dataId, autoId]);
    expect(run?.status).toBe("waiting");
    expect(run?.approval_id).toBeTruthy();
    expect(run?.step_index).toBe(0);
    const approval = await sqlOne<{ id: string; run_id: string; tool_name: string; status: string; input: string }>(`SELECT id, run_id, tool_name, status, input FROM approvals WHERE id = $1 AND user_id = $2`, [run!.approval_id, org.dataId]);
    expect(approval).toMatchObject({ run_id: `auto:${run!.id}`, tool_name: "helpdesk.reply", status: "pending" });
    expect(JSON.parse(approval!.input)).toMatchObject({ ticketId: ticket.id, body: "Triage note for grace@example.com", is_internal: true });
    expect(await sql(`SELECT id FROM ticket_messages WHERE user_id = $1 AND ticket_id = $2 AND is_internal = TRUE`, [org.dataId, ticket.id])).toHaveLength(0);

    const approvals = await import("@/app/api/approvals/[id]/route");
    const decided = await api<{ approval: { status: string }; outcome: string | null }>(approvals.PATCH, `/api/approvals/${approval!.id}`, { method: "PATCH", json: { decision: "approved", edited_input: { ticketId: ticket.id, body: "Edited triage note", is_internal: true } }, params: { id: approval!.id }, expect: 200 });
    expect(decided.body.approval.status).toBe("approved");

    const after = await sqlOne<{ status: string; step_results: string; approval_id: string | null }>(`SELECT status, step_results, approval_id FROM automation_runs WHERE id = $1`, [run!.id]);
    expect(after?.status).toBe("done");
    expect(after?.approval_id).toBeNull();
    const steps = JSON.parse(after!.step_results) as Array<{ step_id: string; status: string }>;
    expect(steps.map((s) => `${s.step_id}:${s.status}`)).toEqual(["reply:waiting", "reply:ok", "note:ok"]);
    const notes = await sql<{ body: string }>(`SELECT body FROM ticket_messages WHERE user_id = $1 AND ticket_id = $2 AND is_internal = TRUE`, [org.dataId, ticket.id]);
    expect(notes.map((n) => n.body)).toEqual(["Edited triage note"]);

    // A second gated run, rejected → skipped.
    const ticket2 = await createTicket(org.dataId, { subject: "Reject me", priority: "low", source: "manual", requester_email: "linus@example.com" });
    await expectEvent(org.dataId, "ticket.created", ticket2.id);
    await fanOutEvents(200);
    await runQueued(50);
    const run2 = await sqlOne<{ id: string; approval_id: string }>(`SELECT id, approval_id FROM automation_runs WHERE user_id = $1 AND automation_id = $2 AND status = 'waiting'`, [org.dataId, autoId]);
    expect(run2?.approval_id).toBeTruthy();
    await api(approvals.PATCH, `/api/approvals/${run2!.approval_id}`, { method: "PATCH", json: { decision: "rejected" }, params: { id: run2!.approval_id }, expect: 200 });
    const rejected = await sqlOne<{ status: string; error: string }>(`SELECT status, error FROM automation_runs WHERE id = $1`, [run2!.id]);
    expect(rejected).toMatchObject({ status: "skipped", error: "Rejected by operator" });
    expect(await sql(`SELECT id FROM ticket_messages WHERE user_id = $1 AND ticket_id = $2 AND is_internal = TRUE`, [org.dataId, ticket2.id])).toHaveLength(0);
  });

  it("test endpoint returns a dry-run plan without executing; delay step parks the run with resume_at", async () => {
    const list = await import("@/app/api/automations/route");
    const created = await api<{ automation: AutomationDTO }>(list.POST, "/api/automations", {
      json: {
        name: "Invoice paid plan",
        trigger_type: "event",
        trigger_config: { event_type: "invoice.paid" },
        conditions: { field: "event.data.total_minor", op: "gte", value: 10000 },
        steps: [
          { id: "wait", kind: "delay", config: { minutes: 60 } },
          { id: "task", kind: "tool", config: { tool: "tasks.create", input: { title: "Thank customer for {{event.data.total_minor | money}}" } } },
          { id: "gate", kind: "approval", config: { title: "Send thank-you?" } },
        ],
        autonomy: "auto",
        enabled: false,
      },
      expect: 201,
    });
    const autoId = created.body.automation.id;
    const test = await import("@/app/api/automations/[id]/test/route");
    const plan = await api<{ plan: { matched: boolean; reason: string | null; steps: Array<{ step_id: string; summary: string; would_pause: boolean; rendered: unknown }> } }>(test.POST, `/api/automations/${autoId}/test`, { json: {}, params: { id: autoId }, expect: 200 });
    expect(plan.body.plan.matched).toBe(true);
    expect(plan.body.plan.steps.map((s) => s.step_id)).toEqual(["wait", "task", "gate"]);
    expect(plan.body.plan.steps[1].rendered).toEqual({ title: "Thank customer for 1250.00" });
    expect(plan.body.plan.steps[2].would_pause).toBe(true);
    const before = await sql(`SELECT id FROM tasks WHERE user_id = $1 AND title LIKE 'Thank customer%'`, [org.dataId]);
    expect(before).toHaveLength(0);

    const miss = await api<{ plan: { matched: boolean; reason: string } }>(test.POST, `/api/automations/${autoId}/test`, { json: { event: { type: "invoice.paid", data: { total_minor: 5 } } }, params: { id: autoId }, expect: 200 });
    expect(miss.body.plan.matched).toBe(false);
    expect(miss.body.plan.reason).toContain("conditions");

    // Manual run: delay parks it with resume_at ≈ now + 60m; forcing resume_at into the past lets runQueued continue.
    const runRoute = await import("@/app/api/automations/[id]/run/route");
    const manual = await api<{ run: RunDTO; runId: string }>(runRoute.POST, `/api/automations/${autoId}/run`, { json: { event: { type: "invoice.paid", data: { total_minor: 20000 } } }, params: { id: autoId }, expect: 201 });
    expect(manual.body.run.status).toBe("waiting");
    const parked = await sqlOne<{ resume_at: Date; step_index: number }>(`SELECT resume_at, step_index FROM automation_runs WHERE id = $1`, [manual.body.runId]);
    expect(parked?.step_index).toBe(1);
    expect(new Date(parked!.resume_at).getTime()).toBeGreaterThan(Date.now() + 50 * 60_000);
    await sql(`UPDATE automation_runs SET resume_at = NOW() - INTERVAL '1 minute' WHERE id = $1`, [manual.body.runId]);
    const { runQueued } = await import("@/lib/automations/engine");
    await runQueued(50);
    const resumed = await sqlOne<{ status: string; approval_id: string | null }>(`SELECT status, approval_id FROM automation_runs WHERE id = $1`, [manual.body.runId]);
    expect(resumed?.status).toBe("waiting");
    expect(resumed?.approval_id).toBeTruthy();
    const task = await sql(`SELECT id FROM tasks WHERE user_id = $1 AND title = 'Thank customer for 200.00'`, [org.dataId]);
    expect(task).toHaveLength(1);
  });

  it("inbound webhook trigger: body becomes event.data; wrong token is a 404", async () => {
    const list = await import("@/app/api/automations/route");
    const token = randomUUID().replace(/-/g, "");
    const created = await api<{ automation: AutomationDTO }>(list.POST, "/api/automations", {
      json: {
        name: "Hook",
        trigger_type: "webhook",
        trigger_config: { webhook: { token } },
        conditions: null,
        steps: [{ id: "task", kind: "tool", config: { tool: "tasks.create", input: { title: "Hook said {{event.data.message}}" } } }],
        autonomy: "auto",
        enabled: true,
      },
      expect: 201,
    });
    const hooks = await import("@/app/api/automations/hooks/[id]/route");
    await api(hooks.POST, `/api/automations/hooks/${created.body.automation.id}?token=wrong`, { json: { message: "nope" }, params: { id: created.body.automation.id }, expect: 404 });
    const ok = await api<{ ok: boolean; run_id: string }>(hooks.POST, `/api/automations/hooks/${created.body.automation.id}`, { json: { message: "hello" }, headers: { "x-automation-token": token }, params: { id: created.body.automation.id }, expect: 202 });
    const { runQueued } = await import("@/lib/automations/engine");
    await runQueued(50);
    const run = await sqlOne<{ status: string }>(`SELECT status FROM automation_runs WHERE id = $1`, [ok.body.run_id]);
    expect(run?.status).toBe("done");
    expect(await sql(`SELECT id FROM tasks WHERE user_id = $1 AND title = 'Hook said hello'`, [org.dataId])).toHaveLength(1);
  });

  it("legacy rows are converted on read, saved into the v2 shape and migrated in bulk", async () => {
    const legacyId = await sqlOne<{ id: string }>(
      `INSERT INTO automations (user_id, name, trigger_event, action_type, kanban_label, action_config, status, run_count)
       VALUES ($1, 'Old kanban nudge', 'Kanban Card Moved', 'Create Task', 'Review', '{"message":"Follow up: {{task_title}}"}', 'active', 3) RETURNING id::text AS id`,
      [org.dataId]
    );
    const byId = await import("@/app/api/automations/[id]/route");
    const got = await api<{ automation: AutomationDTO }>(byId.GET, `/api/automations/${legacyId!.id}`, { params: { id: legacyId!.id }, expect: 200 });
    expect(got.body.automation.legacy).toBe(true);
    expect(got.body.automation.trigger_type).toBe("event");
    expect(got.body.automation.trigger_config.event_type).toBe("production.card.moved");
    expect(got.body.automation.steps[0]).toMatchObject({ kind: "tool", config: { tool: "tasks.create" } });
    expect(got.body.automation.enabled).toBe(true);

    const second = await sqlOne<{ id: string }>(
      `INSERT INTO automations (user_id, name, trigger_event, action_type, action_config, schedule_time, schedule_timezone, schedule_days, status, run_count)
       VALUES ($1, 'Old daily', 'Scheduled (Daily)', 'Send Notification', '{}', '08:00', 'UTC', 'weekdays', 'paused', 0) RETURNING id::text AS id`,
      [org.dataId]
    );
    const { migrateLegacyAutomations } = await import("@/lib/automations/store");
    const n = await migrateLegacyAutomations(org.dataId);
    expect(n).toBe(2);
    const rows = await sql<{ id: string; trigger_type: string; steps: string }>(`SELECT id::text AS id, trigger_type, steps FROM automations WHERE id::text = ANY($1)`, [[legacyId!.id, second!.id]]);
    expect(rows.find((r) => r.id === second!.id)?.trigger_type).toBe("schedule");
    expect(JSON.parse(rows.find((r) => r.id === legacyId!.id)!.steps)).toHaveLength(1);
    const after = await api<{ automation: AutomationDTO }>(byId.GET, `/api/automations/${legacyId!.id}`, { params: { id: legacyId!.id }, expect: 200 });
    expect(after.body.automation.legacy).toBe(false);
  });

  it("API v1: list, get, disable/enable, runs", async () => {
    const keys = await import("@/app/api/api-keys/route");
    const key = await api<{ key: string }>(keys.POST, "/api/api-keys", { json: { name: "automations", scopes: ["read:agents", "write:agents"] }, expect: 201 });
    const bearer = { authorization: `Bearer ${key.body.key}` };
    const listV1 = await import("@/app/api/v1/automations/route");
    const listed = await api<Env<AutomationDTO[]>>(listV1.GET, "/api/v1/automations", { headers: bearer, expect: 200 });
    expect(listed.body.data.length).toBeGreaterThanOrEqual(4);
    const target = listed.body.data.find((a) => a.name === "Hook")!;
    const getV1 = await import("@/app/api/v1/automations/[id]/route");
    const one = await api<Env<AutomationDTO>>(getV1.GET, `/api/v1/automations/${target.id}`, { params: { id: target.id }, headers: bearer, expect: 200 });
    expect(one.body.data.trigger_type).toBe("webhook");
    const disable = await import("@/app/api/v1/automations/[id]/disable/route");
    const off = await api<Env<AutomationDTO>>(disable.POST, `/api/v1/automations/${target.id}/disable`, { method: "POST", params: { id: target.id }, headers: bearer, expect: 200 });
    expect(off.body.data.enabled).toBe(false);
    const enable = await import("@/app/api/v1/automations/[id]/enable/route");
    const on = await api<Env<AutomationDTO>>(enable.POST, `/api/v1/automations/${target.id}/enable`, { method: "POST", params: { id: target.id }, headers: bearer, expect: 200 });
    expect(on.body.data.enabled).toBe(true);
    const runsV1 = await import("@/app/api/v1/automations/[id]/runs/route");
    const runs = await api<Env<RunDTO[]>>(runsV1.GET, `/api/v1/automations/${target.id}/runs`, { params: { id: target.id }, headers: bearer, expect: 200 });
    expect(runs.body.data[0].status).toBe("done");
    const runV1 = await import("@/app/api/v1/automations/runs/[id]/route");
    const run = await api<Env<RunDTO & { context?: unknown }>>(runV1.GET, `/api/v1/automations/runs/${runs.body.data[0].id}`, { params: { id: runs.body.data[0].id }, headers: bearer, expect: 200 });
    expect(run.body.data.context).toBeUndefined();
    const filtered = await api<Env<AutomationDTO[]>>(listV1.GET, "/api/v1/automations", { query: { trigger_type: "webhook" }, headers: bearer, expect: 200 });
    expect(filtered.body.data.every((a) => a.trigger_type === "webhook")).toBe(true);
  });
});
