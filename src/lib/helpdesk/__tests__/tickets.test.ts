import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.fn();
const queryOne = vi.fn();
vi.mock("@/lib/dsql", () => ({
  query: (...args: unknown[]) => query(...args),
  queryOne: (...args: unknown[]) => queryOne(...args),
  withRetry: (fn: () => unknown) => fn(),
}));
const emitEvent = vi.fn<(...args: unknown[]) => Promise<void>>(async () => undefined);
vi.mock("@/lib/events/bus", () => ({ emitEvent: (...a: unknown[]) => emitEvent(...a) }));
const enqueueNotification = vi.fn<(...args: unknown[]) => Promise<string>>(async () => "n1");
vi.mock("@/lib/notifications/outbox", () => ({ enqueueNotification: (...a: unknown[]) => enqueueNotification(...a) }));

import { addMessage, runSlaSweep } from "@/lib/helpdesk/tickets";

function ticket(over: Record<string, unknown> = {}) {
  return {
    id: "t1", user_id: "org", number: 7, subject: "Login broken", status: "open", priority: "normal", source: "portal",
    contact_id: null, requester_email: "a@b.c", requester_name: "Ada", assigned_to: null, sla_policy_id: null,
    first_response_due_at: "2020-01-01T00:00:00Z", resolution_due_at: "2020-01-02T00:00:00Z", first_responded_at: null, resolved_at: null,
    breached_first_response: false, breached_resolution: false, escalated_at: null, tags: "[]", conversation_id: null,
    created_at: "2019-12-31T00:00:00Z", updated_at: "2019-12-31T00:00:00Z", ...over,
  };
}

beforeEach(() => {
  query.mockReset();
  queryOne.mockReset();
  emitEvent.mockClear();
  enqueueNotification.mockClear();
});

describe("addMessage transitions", () => {
  it("stamps first_responded_at only once and flips open → pending atomically in SQL", async () => {
    queryOne.mockImplementation(async (sql: string) => (sql.includes("FROM ticket_messages") ? { id: "m1" } : ticket()));
    query.mockResolvedValue([]);
    await addMessage("org", "t1", { author_kind: "agent", body: "On it" });
    const upd = query.mock.calls.find(([sql]) => String(sql).startsWith("UPDATE tickets SET"));
    const sql = String(upd?.[0]);
    expect(sql).toContain("first_responded_at = COALESCE(first_responded_at, NOW())");
    expect(sql).toContain("CASE WHEN status = 'open' THEN 'pending' ELSE status END");
    expect(sql).not.toMatch(/status = 'pending'(?!\s*THEN)/);
  });

  it("an internal note does not count as a first response", async () => {
    queryOne.mockImplementation(async (sql: string) => (sql.includes("FROM ticket_messages") ? { id: "m1" } : ticket()));
    query.mockResolvedValue([]);
    await addMessage("org", "t1", { author_kind: "agent", body: "private", is_internal: true });
    const upd = query.mock.calls.find(([sql]) => String(sql).startsWith("UPDATE tickets SET"));
    expect(String(upd?.[0])).not.toContain("first_responded_at");
    expect(String(upd?.[0])).not.toContain("pending");
  });

  it("a customer message re-opens only a pending ticket, decided against the live row", async () => {
    queryOne.mockImplementation(async (sql: string) => (sql.includes("FROM ticket_messages") ? { id: "m1" } : ticket({ status: "resolved" })));
    query.mockResolvedValue([]);
    await addMessage("org", "t1", { author_kind: "customer", body: "still broken" });
    const upd = query.mock.calls.find(([sql]) => String(sql).startsWith("UPDATE tickets SET"));
    expect(String(upd?.[0])).toContain("CASE WHEN status = 'pending' THEN 'open' ELSE status END");
    expect(String(upd?.[0])).not.toContain("first_responded_at");
  });
});

describe("runSlaSweep idempotency", () => {
  it("flags with a conditional UPDATE and escalates once", async () => {
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM tickets")) return [ticket()];
      if (sql.includes("breached_first_response = breached_first_response OR")) {
        expect(sql).toContain("AND (($3 AND breached_first_response = FALSE) OR ($4 AND breached_resolution = FALSE))");
        return [{ id: "t1" }];
      }
      if (sql.includes("SET escalated_at = NOW()")) {
        expect(sql).toContain("escalated_at IS NULL");
        return [{ id: "t1" }];
      }
      return [];
    });
    const res = await runSlaSweep(10);
    expect(res).toEqual({ scanned: 1, breachedFirstResponse: 1, breachedResolution: 1, escalated: 1 });
    expect(enqueueNotification).toHaveBeenCalledTimes(1);
  });

  it("a concurrent sweep that already flagged the ticket makes this one a no-op", async () => {
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM tickets")) return [ticket()];
      return []; // conditional UPDATE matched nothing
    });
    const res = await runSlaSweep(10);
    expect(res).toEqual({ scanned: 1, breachedFirstResponse: 0, breachedResolution: 0, escalated: 0 });
    expect(enqueueNotification).not.toHaveBeenCalled();
    expect(emitEvent).not.toHaveBeenCalled();
  });

  it("does not re-notify a ticket that was escalated earlier", async () => {
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM tickets")) return [ticket({ breached_first_response: true, escalated_at: "2020-01-01T01:00:00Z" })];
      if (sql.includes("breached_first_response = breached_first_response OR")) return [{ id: "t1" }];
      if (sql.includes("SET escalated_at = NOW()")) throw new Error("must not try to escalate again");
      return [];
    });
    const res = await runSlaSweep(10);
    expect(res).toEqual({ scanned: 1, breachedFirstResponse: 0, breachedResolution: 1, escalated: 0 });
    expect(enqueueNotification).not.toHaveBeenCalled();
  });
});
