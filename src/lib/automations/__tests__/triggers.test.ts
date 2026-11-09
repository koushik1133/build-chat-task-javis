import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.fn();
const queryOne = vi.fn();
vi.mock("@/lib/dsql", () => ({
  query: (...args: unknown[]) => query(...args),
  queryOne: (...args: unknown[]) => queryOne(...args),
  withRetry: async <T,>(fn: () => Promise<T>) => fn(),
}));

import { fanOutEvents, matchesEventType, matchesFilter, triggerMatches } from "@/lib/automations/triggers";
import type { AutomationDefinition, RunEvent } from "@/lib/automations/types";

beforeEach(() => {
  query.mockReset();
  queryOne.mockReset();
  query.mockResolvedValue([]);
});

describe("matchesEventType", () => {
  it("supports exact, prefix wildcard, * and comma lists", () => {
    expect(matchesEventType("invoice.paid", "invoice.paid")).toBe(true);
    expect(matchesEventType("invoice.paid", "invoice.sent")).toBe(false);
    expect(matchesEventType("invoice.*", "invoice.sent")).toBe(true);
    expect(matchesEventType("invoice.*", "invoices.sent")).toBe(false);
    expect(matchesEventType("*", "anything.at_all")).toBe(true);
    expect(matchesEventType("ticket.created, ticket.sla_breached", "ticket.sla_breached")).toBe(true);
    expect(matchesEventType(undefined, "x.y")).toBe(false);
  });
});

describe("matchesFilter", () => {
  it("compares event.data values as strings and supports null = missing", () => {
    expect(matchesFilter({ kind: "receive" }, { kind: "receive" })).toBe(true);
    expect(matchesFilter({ low_stock: true }, { low_stock: true })).toBe(true);
    expect(matchesFilter({ low_stock: true }, { low_stock: false })).toBe(false);
    expect(matchesFilter({ quote_id: null }, {})).toBe(true);
    expect(matchesFilter({ quote_id: null }, { quote_id: "q1" })).toBe(false);
    expect(matchesFilter(undefined, {})).toBe(true);
  });
});

const def = (over: Partial<AutomationDefinition> = {}): AutomationDefinition => ({
  name: "t",
  trigger_type: "event",
  trigger_config: { event_type: "ticket.*" },
  conditions: null,
  steps: [],
  autonomy: "auto",
  enabled: true,
  ...over,
});
const evt = (type: string, data: Record<string, unknown> = {}): RunEvent => ({ id: "e1", type, entity: "ticket", entity_id: "t1", data, created_at: "2026-01-01T00:00:00Z" });

describe("triggerMatches", () => {
  it("requires enabled event trigger + type match + filter", () => {
    expect(triggerMatches(def(), evt("ticket.created"), "a1")).toBe(true);
    expect(triggerMatches(def({ enabled: false }), evt("ticket.created"), "a1")).toBe(false);
    expect(triggerMatches(def({ trigger_type: "schedule" }), evt("ticket.created"), "a1")).toBe(false);
    expect(triggerMatches(def(), evt("invoice.paid"), "a1")).toBe(false);
    expect(triggerMatches(def({ trigger_config: { event_type: "ticket.*", filter: { priority: "urgent" } } }), evt("ticket.created", { priority: "low" }), "a1")).toBe(false);
  });
  it("ignores its own run events (loop guard)", () => {
    const d = def({ trigger_config: { event_type: "automation.*" } });
    expect(triggerMatches(d, evt("automation.run_failed", { automation_id: "a1" }), "a1")).toBe(false);
    expect(triggerMatches(d, evt("automation.run_failed", { automation_id: "other" }), "a1")).toBe(true);
  });
  it("catch-all patterns never fire on other automations' run events (ping-pong guard)", () => {
    for (const pattern of ["*", "automation*", "ticket.*,*"]) {
      const d = def({ trigger_config: { event_type: pattern } });
      expect(triggerMatches(d, evt("automation.run_finished", { automation_id: "other" }), "a1"), pattern).toBe(false);
      expect(triggerMatches(d, evt("automation.run_failed", { automation_id: "other" }), "a1"), pattern).toBe(false);
    }
    expect(triggerMatches(def({ trigger_config: { event_type: "*" } }), evt("ticket.created"), "a1")).toBe(true);
    expect(triggerMatches(def({ trigger_config: { event_type: "automation.run_finished" } }), evt("automation.run_finished", { automation_id: "other" }), "a1")).toBe(true);
    expect(triggerMatches(def({ trigger_config: { event_type: "ticket.*, automation.*" } }), evt("automation.run_finished", { automation_id: "other" }), "a1")).toBe(true);
  });
});

describe("fanOutEvents", () => {
  it("initialises the cursor at now on first run without replaying history", async () => {
    queryOne.mockResolvedValueOnce(null);
    const out = await fanOutEvents(10);
    expect(out).toEqual({ scanned: 0, matched: 0, queued: 0 });
    expect(String(query.mock.calls[0][0])).toContain("INSERT INTO automation_cursors");
  });

  it("queues one run per matching automation, evaluates conditions, advances the watermark in SQL and is idempotent per (automation, event)", async () => {
    queryOne.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM automation_cursors")) return { last_event_at: new Date("2026-01-01T00:00:00Z") };
      if (sql.includes("FROM organizations")) return { name: "Acme" };
      if (sql.includes("FROM tickets")) return { id: "t1", user_id: "u1", priority: "urgent", subject: "Help" };
      return null;
    });
    // Idempotency: a run for (a-wild, e2) already exists.
    queryOne.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes("FROM automation_cursors")) return { last_event_at: new Date("2026-01-01T00:00:00Z") };
      if (sql.includes("FROM organizations")) return { name: "Acme" };
      if (sql.includes("FROM tickets")) return { id: "t1", user_id: "u1", priority: "urgent", subject: "Help" };
      if (sql.includes("SELECT id FROM automation_runs")) return params?.[1] === "e2" ? { id: "existing" } : null;
      return null;
    });
    const automations = [
      { id: "a-wild", user_id: "u1", name: "wild", trigger_type: "event", trigger_config: JSON.stringify({ event_type: "ticket.*" }), conditions: null, steps: "[]", enabled: true, autonomy: "auto", status: "active" },
      { id: "a-cond", user_id: "u1", name: "cond", trigger_type: "event", trigger_config: JSON.stringify({ event_type: "ticket.created" }), conditions: JSON.stringify({ field: "entity.priority", op: "eq", value: "low" }), steps: "[]", enabled: true, autonomy: "auto", status: "active" },
      { id: "a-other", user_id: "u1", name: "other", trigger_type: "event", trigger_config: JSON.stringify({ event_type: "invoice.paid" }), conditions: null, steps: "[]", enabled: true, autonomy: "auto", status: "active" },
    ];
    const events = [
      { id: "e1", user_id: "u1", type: "ticket.created", entity: "ticket", entity_id: "t1", data: JSON.stringify({ number: 1 }), created_at: new Date("2026-01-01T00:00:01Z") },
      { id: "e2", user_id: "u1", type: "ticket.resolved", entity: "ticket", entity_id: "t1", data: "{}", created_at: new Date("2026-01-01T00:00:02Z") },
    ];
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM events e")) return events;
      if (sql.includes("FROM automations")) return automations;
      return [];
    });
    const out = await fanOutEvents(50);
    // e1: wild matches (cond fails: priority urgent ≠ low; other: wrong type) → queued; e2: wild matches but already has a run → not queued.
    expect(out).toEqual({ scanned: 2, matched: 2, queued: 1 });
    const inserts = query.mock.calls.filter(([sql]) => String(sql).includes("INSERT INTO automation_runs"));
    expect(inserts).toHaveLength(1);
    expect((inserts[0][1] as unknown[])[2]).toBe("a-wild");
    expect((inserts[0][1] as unknown[])[3]).toBe("e1");
    const ctxJson = JSON.parse(String((inserts[0][1] as unknown[])[4])) as { entity: { subject: string }; org: { name: string } };
    expect(ctxJson.entity.subject).toBe("Help");
    expect(ctxJson.org.name).toBe("Acme");
    const cursor = query.mock.calls.find(([sql]) => String(sql).includes("UPDATE automation_cursors"))!;
    expect(cursor[0]).toContain("(SELECT created_at FROM events WHERE id = $2)");
    expect(cursor[1]).toEqual(["events", "e2"]);
  });

  it("skips users without event automations and still advances the cursor", async () => {
    queryOne.mockResolvedValueOnce({ last_event_at: new Date() });
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM events e")) return [{ id: "e9", user_id: "u2", type: "x.y", entity: "x", entity_id: "1", data: null, created_at: new Date() }];
      return [];
    });
    const out = await fanOutEvents(5);
    expect(out).toEqual({ scanned: 1, matched: 0, queued: 0 });
    expect(query.mock.calls.some(([sql]) => String(sql).includes("UPDATE automation_cursors"))).toBe(true);
  });
});
