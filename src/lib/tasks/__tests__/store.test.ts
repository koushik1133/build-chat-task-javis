import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ query: vi.fn(), queryOne: vi.fn(), withRetry: (fn: () => unknown) => fn(), transaction: vi.fn() }));
vi.mock("@/lib/dsql", () => db);
vi.mock("@/lib/events/bus", () => ({ emitEvent: vi.fn(async () => undefined), EVENT_TYPES: [] }));

import { createTask, isOverdue, isTaskPriority, listTasks, toTaskDTO, updateTask } from "@/lib/tasks/store";

const now = new Date("2026-03-10T12:00:00Z");

describe("tasks store (due_at / assignee_id / priority)", () => {
  beforeEach(() => {
    db.query.mockReset();
    db.queryOne.mockReset();
  });

  it("computes overdue only for open tasks past due_at and defaults priority", () => {
    expect(isOverdue({ done: false, due_at: "2026-03-09T00:00:00Z" }, now)).toBe(true);
    expect(isOverdue({ done: true, due_at: "2026-03-09T00:00:00Z" }, now)).toBe(false);
    expect(isOverdue({ done: false, due_at: "2026-03-11T00:00:00Z" }, now)).toBe(false);
    expect(isOverdue({ done: false, due_at: null }, now)).toBe(false);
    const dto = toTaskDTO({ id: "t1", title: "Call", done: false, chat_id: null, due_at: new Date("2026-03-01T00:00:00Z"), assignee_id: "u-2", priority: "bogus", created_at: new Date("2026-02-01T00:00:00Z") }, now);
    expect(dto).toMatchObject({ id: "t1", due_at: "2026-03-01T00:00:00.000Z", assignee_id: "u-2", priority: "normal", overdue: true });
    expect(isTaskPriority("urgent")).toBe(true);
    expect(isTaskPriority("asap")).toBe(false);
  });

  it("inserts the new columns and emits task.created with them", async () => {
    db.queryOne.mockResolvedValueOnce({ id: "t2", title: "Ship it", done: false, chat_id: null, due_at: "2026-03-12T09:00:00.000Z", assignee_id: "u-9", priority: "high", created_at: "2026-03-10T00:00:00.000Z" });
    const t = await createTask("org-1", { title: "  Ship it ", due_at: "2026-03-12T09:00:00.000Z", assignee_id: "u-9", priority: "high" }, "app");
    const [sql, params] = db.queryOne.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("INSERT INTO tasks (user_id, title, due_at, assignee_id, priority, chat_id)");
    expect(params).toEqual(["org-1", "Ship it", "2026-03-12T09:00:00.000Z", "u-9", "high", null]);
    expect(t.priority).toBe("high");
    expect(t.assignee_id).toBe("u-9");
  });

  it("patches only the provided fields (null clears due_at / assignee_id)", async () => {
    db.queryOne.mockResolvedValueOnce({ id: "t3", title: "X", done: false, chat_id: null, due_at: null, assignee_id: null, priority: "low", created_at: "2026-03-10T00:00:00.000Z" });
    await updateTask("org-1", "t3", { due_at: null, assignee_id: null, priority: "low" });
    const [sql, params] = db.queryOne.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("due_at = $3");
    expect(sql).toContain("assignee_id = $4");
    expect(sql).toContain("priority = $5");
    expect(sql).not.toContain("title =");
    expect(params).toEqual(["t3", "org-1", null, null, "low"]);
  });

  it("filters by assignee and overdue in the list query", async () => {
    db.query.mockResolvedValueOnce([]);
    await listTasks("org-1", { assigneeId: "u-1", overdue: true, limit: 10 });
    const [sql, params] = db.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("assignee_id = $2");
    expect(sql).toContain("due_at < NOW()");
    expect(params).toEqual(["org-1", "u-1", 10]);
  });
});
