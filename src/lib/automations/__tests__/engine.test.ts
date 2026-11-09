import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const query = vi.fn();
const queryOne = vi.fn();
vi.mock("@/lib/dsql", () => ({
  query: (...args: unknown[]) => query(...args),
  queryOne: (...args: unknown[]) => queryOne(...args),
  withRetry: async <T,>(fn: () => Promise<T>) => fn(),
}));
const emitEvent = vi.fn(async () => undefined);
vi.mock("@/lib/events/bus", () => ({ emitEvent: (...a: unknown[]) => emitEvent(...(a as [])), EVENT_TYPES: [] }));
vi.mock("@/lib/agents/tools/index", () => ({ ensureToolsLoaded: () => undefined }));

import { executeRun, planRun, resumeAutomationRun, runQueued } from "@/lib/automations/engine";
import type { StepDeps } from "@/lib/automations/actions";
import type { AutomationRow, RunRow } from "@/lib/automations/store";
import type { RunContext, Step, StepResult } from "@/lib/automations/types";
import type { ToolSpec } from "@/lib/agents/types";

/* ── fakes ─────────────────────────────────────────────────────────────── */

const toolRuns: unknown[] = [];
const tools: Record<string, ToolSpec> = {
  "tasks.create": {
    name: "tasks.create",
    module: "tasks",
    description: "",
    input: z.object({ title: z.string().min(1) }),
    parameters: {},
    scope: "write",
    requiresApproval: false,
    preview: (i) => `Create task "${(i as { title: string }).title}"`,
    run: async (_ctx, input) => {
      toolRuns.push(input);
      return { ok: true, summary: "created", data: { id: "task1", ...(input as object) } };
    },
  },
  "comms.send_email": {
    name: "comms.send_email",
    module: "comms",
    description: "",
    input: z.object({ to: z.string(), body: z.string() }),
    parameters: {},
    scope: "write",
    run: async (_ctx, input) => {
      toolRuns.push(input);
      return { ok: true, summary: "sent", data: { to: (input as { to: string }).to } };
    },
  },
  "boom.fail": { name: "boom.fail", module: "boom", description: "", input: z.object({}), parameters: {}, scope: "read", run: async () => ({ ok: false, summary: "nope", error: "exploded" }) },
};
const approvals: Array<{ id: string; tool: string; input: unknown }> = [];
const notifications: unknown[] = [];
const agentRuns: unknown[] = [];
const webhooks: unknown[] = [];
let now = new Date("2026-01-01T00:00:00Z");

const deps: StepDeps = {
  getTool: (n) => tools[n],
  needsApproval: (spec, _i, ctx) => (ctx.autonomy === "auto" ? false : spec.requiresApproval === false ? false : spec.scope === "write"),
  createApproval: async (_env, tool, input) => {
    const id = `ap${approvals.length + 1}`;
    approvals.push({ id, tool, input });
    return id;
  },
  enqueueNotification: async (_d, input) => {
    notifications.push(input);
    return "nb1";
  },
  canSendMarketing: async (_d, contactId) => (contactId === "c-ok" ? { allowed: true, reason: "granted" } : { allowed: false, reason: "no_consent" }),
  startAgentRun: async (_d, agentId, prompt) => {
    agentRuns.push({ agentId, prompt });
    return "agentrun1";
  },
  sendWebhook: async (url, _s, payload) => {
    webhooks.push({ url, payload });
    return url.includes("bad") ? { ok: false, status: 500, ms: 3, error: "boom" } : { ok: true, status: 200, ms: 5 };
  },
  now: () => now,
};

const context = (): RunContext => ({
  event: { id: "e1", type: "ticket.created", entity: "ticket", entity_id: "t1", data: { number: 7, priority: "urgent", email: "ada@example.com" }, created_at: now.toISOString() },
  entity: { id: "t1", subject: "Help me" },
  org: { id: "u1", name: "Acme" },
  automation: { id: "a1", name: "Test" },
  steps: {},
  now: now.toISOString(),
});

function automation(steps: Step[], autonomy: "auto" | "approve" = "auto"): AutomationRow {
  return {
    id: "a1", user_id: "u1", name: "Test", trigger_event: "x", action_type: "x", kanban_label: null, action_config: null, schedule_time: null, schedule_timezone: null, schedule_days: null, status: "active",
    trigger_type: "event", trigger_config: JSON.stringify({ event_type: "ticket.*" }), conditions: null, steps: JSON.stringify(steps), version: 1, enabled: true, autonomy, description: null, template_key: null,
    run_count: 0, error_count: 0, last_run_at: null, last_error: null, created_at: now, updated_at: null,
  };
}
function run(ctx: RunContext = context(), over: Partial<RunRow> = {}): RunRow {
  return { id: "r1", user_id: "u1", automation_id: "a1", trigger_event_id: "e1", status: "running", context: JSON.stringify(ctx), step_results: "[]", step_index: 0, approval_id: null, error: null, attempt: 1, started_at: null, finished_at: null, resume_at: null, created_at: now, ...over };
}

/** Captures the last persisted state from UPDATE automation_runs calls. */
function lastRunUpdate(): { sql: string; params: unknown[] } | null {
  const calls = query.mock.calls.filter(([sql]) => String(sql).startsWith("UPDATE automation_runs"));
  if (calls.length === 0) return null;
  const [sql, params] = calls[calls.length - 1];
  return { sql: String(sql), params: params as unknown[] };
}
function resultsFrom(params: unknown[], sql: string): StepResult[] {
  const idx = sql.includes("step_results = $4") ? 3 : sql.includes("step_results = $3") ? 2 : 1;
  return JSON.parse(String(params[idx])) as StepResult[];
}

beforeEach(() => {
  query.mockReset();
  queryOne.mockReset();
  emitEvent.mockClear();
  query.mockResolvedValue([]);
  toolRuns.length = 0;
  approvals.length = 0;
  notifications.length = 0;
  agentRuns.length = 0;
  webhooks.length = 0;
  now = new Date("2026-01-01T00:00:00Z");
});

/* ── tests ─────────────────────────────────────────────────────────────── */

describe("executeRun", () => {
  it("runs tool → notify → webhook sequentially, templating inputs and exposing step outputs", async () => {
    const steps: Step[] = [
      { id: "task", kind: "tool", config: { tool: "tasks.create", input: { title: "Ticket #{{event.data.number}}: {{entity.subject}}" } } },
      { id: "note", kind: "notify", config: { channel: "in_app", to: "{{org.id}}", subject: "Task {{steps.task.id}}", body: "<b>{{entity.subject}}</b>" } },
      { id: "hook", kind: "webhook", config: { url: "https://ok.test/h", payload: { task: "{{steps.task.id}}", n: "{{event.data.number}}" } } },
    ];
    const status = await executeRun(run(), automation(steps), deps);
    expect(status).toBe("done");
    expect(toolRuns[0]).toEqual({ title: "Ticket #7: Help me" });
    expect(notifications[0]).toMatchObject({ channel: "in_app", recipient: "u1", subject: "Task task1", body: "<b>Help me</b>" });
    expect(JSON.parse(String((webhooks[0] as { payload: string }).payload))).toEqual({ task: "task1", n: 7 });
    const last = lastRunUpdate()!;
    expect(last.params[1]).toBe("done");
    expect(resultsFrom(last.params, last.sql).map((r) => r.status)).toEqual(["ok", "ok", "ok"]);
    expect(emitEvent).toHaveBeenCalledWith("u1", expect.objectContaining({ type: "automation.run_finished" }));
    expect(query.mock.calls.some(([sql]) => String(sql).includes("UPDATE automations SET run_count"))).toBe(true);
  });

  it("escapes HTML in email bodies and skips marketing sends without consent", async () => {
    const steps: Step[] = [
      { id: "mail", kind: "notify", config: { channel: "email", to: "{{event.data.email}}", body: "Hi {{entity.subject}} <script>", marketing: true, contact_id: "c-no" } },
      { id: "mail2", kind: "notify", config: { channel: "email", to: "{{event.data.email}}", body: "Hi {{entity.subject}}", marketing: true, contact_id: "c-ok" } },
    ];
    const ctx = context();
    ctx.entity = { subject: "<i>x</i>" };
    expect(await executeRun(run(ctx), automation(steps), deps)).toBe("done");
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({ recipient: "ada@example.com", body: "Hi &lt;i&gt;x&lt;/i&gt;" });
    const last = lastRunUpdate()!;
    const results = resultsFrom(last.params, last.sql);
    expect(results[0].status).toBe("skipped");
    expect(results[0].summary).toContain("no_consent");
    expect(results[1].status).toBe("ok");
  });

  it("fails the run when a tool fails, records the error and emits run_failed", async () => {
    const status = await executeRun(run(), automation([{ id: "b", kind: "tool", name: "Boom", config: { tool: "boom.fail", input: {} } }, { id: "t", kind: "tool", config: { tool: "tasks.create", input: { title: "never" } } }]), deps);
    expect(status).toBe("failed");
    expect(toolRuns).toHaveLength(0);
    const last = lastRunUpdate()!;
    expect(last.params[1]).toBe("failed");
    expect(last.params[2]).toBe("Boom: exploded");
    expect(emitEvent).toHaveBeenCalledWith("u1", expect.objectContaining({ type: "automation.run_failed" }));
    expect(query.mock.calls.some(([sql]) => String(sql).includes("error_count = COALESCE(error_count, 0) + 1"))).toBe(true);
  });

  it("fails on invalid templated input and on unknown tools", async () => {
    expect(await executeRun(run(), automation([{ id: "t", kind: "tool", config: { tool: "tasks.create", input: { title: "{{entity.nothing}}" } } }]), deps)).toBe("failed");
    expect(lastRunUpdate()!.params[2]).toContain("invalid input for tasks.create");
    expect(await executeRun(run(), automation([{ id: "t", kind: "tool", config: { tool: "nope.tool", input: {} } }]), deps)).toBe("failed");
  });

  it("branch jumps to `then`/`else` targets, `end` stops, bad targets fail", async () => {
    const steps: Step[] = [
      { id: "check", kind: "branch", config: { conditions: { field: "event.data.priority", op: "eq", value: "urgent" }, then: "urgent", else: "end" } },
      { id: "skip_me", kind: "tool", config: { tool: "tasks.create", input: { title: "skipped" } } },
      { id: "urgent", kind: "tool", config: { tool: "tasks.create", input: { title: "urgent!" } } },
    ];
    expect(await executeRun(run(), automation(steps), deps)).toBe("done");
    expect(toolRuns).toEqual([{ title: "urgent!" }]);

    toolRuns.length = 0;
    const ctx = context();
    ctx.event.data.priority = "low";
    expect(await executeRun(run(ctx), automation(steps), deps)).toBe("done");
    expect(toolRuns).toEqual([]);

    expect(await executeRun(run(), automation([{ id: "b", kind: "branch", config: { conditions: { all: [] }, then: "ghost" } }]), deps)).toBe("failed");
    expect(lastRunUpdate()!.params[2]).toContain('branch target "ghost" not found');
  });

  it("delay pauses the run with resume_at and step_index pointing at the next step; a due delay continues", async () => {
    const steps: Step[] = [
      { id: "wait", kind: "delay", config: { minutes: 30 } },
      { id: "after", kind: "tool", config: { tool: "tasks.create", input: { title: "later" } } },
    ];
    expect(await executeRun(run(), automation(steps), deps)).toBe("waiting");
    const last = lastRunUpdate()!;
    expect(last.sql).toContain("status = 'waiting', resume_at = $2");
    expect(last.params[1]).toBe("2026-01-01T00:30:00.000Z");
    expect(last.params[3]).toBe(1); // step_index → next step
    expect(toolRuns).toHaveLength(0);

    // The cron later claims the waiting run and continues from step_index 1.
    expect(await executeRun(run(context(), { step_index: 1, step_results: last.params[2] as string }), automation(steps), deps)).toBe("done");
    expect(toolRuns).toEqual([{ title: "later" }]);
  });

  it("delay with a templated `until` in the past elapses immediately; far future is capped at 30 days", async () => {
    const ctx = context();
    ctx.entity = { due: "2025-12-01T00:00:00Z" };
    expect(await executeRun(run(ctx), automation([{ id: "w", kind: "delay", config: { until: "{{entity.due}}" } }]), deps)).toBe("done");
    ctx.entity = { due: "2030-01-01T00:00:00Z" };
    expect(await executeRun(run(ctx), automation([{ id: "w", kind: "delay", config: { until: "{{entity.due}}" } }]), deps)).toBe("waiting");
    expect(lastRunUpdate()!.params[1]).toBe("2026-01-31T00:00:00.000Z");
  });

  it("agent step queues a run with the rendered prompt", async () => {
    expect(await executeRun(run(), automation([{ id: "ag", kind: "agent", config: { agent_id: "agent-1", prompt: "Handle ticket {{event.data.number}}" } }]), deps)).toBe("done");
    expect(agentRuns[0]).toEqual({ agentId: "agent-1", prompt: "Handle ticket 7" });
  });

  it("webhook failure fails the run", async () => {
    expect(await executeRun(run(), automation([{ id: "h", kind: "webhook", config: { url: "https://bad.test/h" } }]), deps)).toBe("failed");
  });

  it("enforces the step budget", async () => {
    const steps: Step[] = [
      { id: "a", kind: "branch", config: { conditions: { all: [] }, then: "b" } },
      { id: "b", kind: "branch", config: { conditions: { all: [] }, then: "a" } },
    ];
    expect(await executeRun(run(), automation(steps), deps)).toBe("failed");
    expect(lastRunUpdate()!.params[2]).toContain("step budget");
  });
});

describe("approval gating + resume", () => {
  const steps: Step[] = [
    { id: "mail", kind: "tool", config: { tool: "comms.send_email", input: { to: "{{event.data.email}}", body: "Hello {{entity.subject}}" } } },
    { id: "task", kind: "tool", config: { tool: "tasks.create", input: { title: "after approval" } } },
  ];

  it("with autonomy=approve a gated write creates an approval and parks the run on that step", async () => {
    expect(await executeRun(run(), automation(steps, "approve"), deps)).toBe("waiting");
    expect(approvals).toEqual([{ id: "ap1", tool: "comms.send_email", input: { to: "ada@example.com", body: "Hello Help me" } }]);
    const last = lastRunUpdate()!;
    expect(last.sql).toContain("status = 'waiting', resume_at = NULL, approval_id = $2");
    expect(last.params[1]).toBe("ap1");
    expect(last.params[3]).toBe(0); // stays on the gated step
    expect(toolRuns).toHaveLength(0);
  });

  it("with autonomy=auto the same step runs without an approval", async () => {
    expect(await executeRun(run(), automation(steps, "auto"), deps)).toBe("done");
    expect(approvals).toHaveLength(0);
    expect(toolRuns).toHaveLength(2);
  });

  it("explicit approval steps always pause", async () => {
    expect(await executeRun(run(), automation([{ id: "gate", kind: "approval", config: { title: "Send to {{event.data.email}}?" } }], "auto"), deps)).toBe("waiting");
    expect(approvals[0]).toMatchObject({ tool: "automations.continue", input: { step_id: "gate", title: "Send to ada@example.com?" } });
  });

  it("resumeAutomationRun executes the approved tool with the (edited) approval input and finishes the remaining steps", async () => {
    const waiting = run(context(), { status: "waiting", approval_id: "ap1", step_index: 0, step_results: JSON.stringify([{ step_id: "mail", kind: "tool", status: "waiting", summary: "Waiting", ms: 1, at: "x" }]) });
    queryOne.mockImplementation(async (sql: string) => {
      if (sql.includes("UPDATE automation_runs r SET status = 'running'")) return waiting;
      if (sql.includes("FROM automations WHERE")) return automation(steps, "approve");
      return null;
    });
    const status = await resumeAutomationRun("u1", "r1", { id: "ap1", status: "approved", tool_name: "comms.send_email", input: JSON.stringify({ to: "edited@example.com", body: "Edited" }) }, deps);
    expect(status).toBe("done");
    expect(toolRuns).toEqual([{ to: "edited@example.com", body: "Edited" }, { title: "after approval" }]);
    const last = lastRunUpdate()!;
    expect(last.params[1]).toBe("done");
    const results = resultsFrom(last.params, last.sql);
    expect(results.map((r) => r.status)).toEqual(["waiting", "ok", "ok"]);
  });

  it("a rejected approval ends the run as skipped without executing anything", async () => {
    const waiting = run(context(), { status: "waiting", approval_id: "ap1", step_index: 0 });
    queryOne.mockImplementation(async (sql: string) => {
      if (sql.includes("UPDATE automation_runs r SET status = 'running'")) return waiting;
      if (sql.includes("FROM automations WHERE")) return automation(steps, "approve");
      return null;
    });
    expect(await resumeAutomationRun("u1", "r1", { id: "ap1", status: "rejected", tool_name: "comms.send_email", input: null }, deps)).toBe("skipped");
    expect(toolRuns).toHaveLength(0);
    expect(lastRunUpdate()!.params[2]).toBe("Rejected by operator");
  });

  it("ignores approvals that do not belong to a waiting run", async () => {
    queryOne.mockResolvedValue(null);
    expect(await resumeAutomationRun("u1", "r1", { id: "nope", status: "approved", tool_name: "x", input: null }, deps)).toBeNull();
  });
});

describe("planRun (dry run)", () => {
  it("reports trigger/conditions match, rendered inputs, pauses and warnings without executing", () => {
    const def = {
      name: "Test",
      trigger_type: "event" as const,
      trigger_config: { event_type: "ticket.*" },
      conditions: { field: "event.data.priority", op: "eq" as const, value: "urgent" },
      steps: [
        { id: "mail", kind: "tool" as const, config: { tool: "comms.send_email", input: { to: "{{event.data.email}}", body: "Hi" } } },
        { id: "bad", kind: "tool" as const, config: { tool: "tasks.create", input: { title: "{{entity.missing}}" } } },
        { id: "n", kind: "notify" as const, config: { channel: "email" as const, to: "{{entity.missing}}", body: "x", marketing: true } },
      ],
      autonomy: "approve" as const,
      enabled: true,
    };
    const plan = planRun(def, "a1", context(), deps);
    expect(plan.matched).toBe(true);
    expect(plan.steps[0]).toMatchObject({ would_pause: true, rendered: { to: "ada@example.com" } });
    expect(plan.steps[1].warnings[0]).toContain("invalid input");
    expect(plan.steps[2].warnings).toEqual(expect.arrayContaining([expect.stringContaining("empty"), expect.stringContaining("contact_id")]));
    expect(toolRuns).toHaveLength(0);
    expect(approvals).toHaveLength(0);

    const miss = planRun({ ...def, trigger_config: { event_type: "invoice.*" } }, "a1", context(), deps);
    expect(miss.matched).toBe(false);
    expect(miss.reason).toContain("does not match");
    const cond = planRun({ ...def, conditions: { field: "event.data.priority", op: "eq", value: "low" } }, "a1", context(), deps);
    expect(cond.reason).toContain("conditions");
  });
});

describe("runQueued housekeeping", () => {
  const steps: Step[] = [{ id: "mail", kind: "tool", config: { tool: "comms.send_email", input: { to: "x@example.com", body: "hi" } } }];

  it("fails runs whose execution lease lapsed and finishes waiting runs whose approval expired outside decideApproval()", async () => {
    const waiting = run(context(), { status: "waiting", approval_id: "ap9", step_index: 0 });
    query.mockImplementation(async (sql: string) => {
      const q = String(sql);
      if (q.startsWith("UPDATE automation_runs SET status = 'failed'") && q.includes("status = 'running'")) return [{ id: "stale1", user_id: "u1", automation_id: "a1" }];
      if (q.startsWith("UPDATE approvals SET status = 'expired'")) return [];
      if (q.includes("JOIN approvals a ON a.id = r.approval_id")) return [{ run_id: "r1", user_id: "u1", approval_id: "ap9", status: "expired", tool_name: "comms.send_email", input: null }];
      return [];
    });
    queryOne.mockImplementation(async (sql: string) => {
      if (String(sql).includes("UPDATE automation_runs r SET status = 'running'")) return waiting;
      if (String(sql).includes("FROM automations WHERE")) return automation(steps, "approve");
      return null;
    });
    const out = await runQueued(10, deps);
    expect(out).toMatchObject({ reaped: 1, resumed: 1, claimed: 0 });
    // The reaper only touches rows past the lease.
    const reap = query.mock.calls.find(([sql]) => String(sql).includes("status = 'running' AND COALESCE(started_at, created_at) <"));
    expect(reap).toBeTruthy();
    expect(emitEvent).toHaveBeenCalledWith("u1", expect.objectContaining({ type: "automation.run_failed", entityId: "stale1" }));
    // The stranded run ended as skipped with the expiry reason, without executing the gated tool.
    expect(toolRuns).toHaveLength(0);
    const finish = query.mock.calls.find(([sql, params]) => String(sql).startsWith("UPDATE automation_runs SET status = $2") && (params as unknown[])[1] === "skipped");
    expect(finish).toBeTruthy();
    expect((finish![1] as unknown[])[2]).toBe("Approval expired");
    // Claims renew the lease timestamp.
    const claim = queryOne.mock.calls.find(([sql]) => String(sql).includes("UPDATE automation_runs r SET status = 'running'"));
    expect(String(claim![0])).toContain("started_at = NOW()");
  });

  it("reports zero housekeeping when nothing is stale or decided", async () => {
    const out = await runQueued(10, deps);
    expect(out).toEqual({ claimed: 0, done: 0, waiting: 0, failed: 0, resumed: 0, reaped: 0 });
  });
});
