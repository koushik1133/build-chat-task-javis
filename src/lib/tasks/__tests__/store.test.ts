import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ query: vi.fn(), queryOne: vi.fn(), withRetry: (fn: () => unknown) => fn(), transaction: vi.fn() }));
vi.mock("@/lib/dsql", () => db);
vi.mock("@/lib/events/bus", () => ({ emitEvent: vi.fn(async () => undefined), EVENT_TYPES: [] }));
vi.mock("@/lib/auth/members", () => ({ isWorkspaceMember: vi.fn(async () => true) }));

import { createTask, isOverdue, isTaskPriority, listTasks, normaliseTaskPriority, toTaskDTO, updateTask } from "@/lib/tasks/store";

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

  it("re-dating a task clears overdue_notified_at so the sweep can flag it again", async () => {
    db.queryOne.mockResolvedValueOnce({ id: "t4", title: "X", done: false, chat_id: null, due_at: "2026-03-20T00:00:00.000Z", assignee_id: null, priority: "normal", created_at: "2026-03-10T00:00:00.000Z" });
    await updateTask("org-1", "t4", { due_at: "2026-03-20T00:00:00.000Z" });
    const [sql, params] = db.queryOne.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("due_at = $3");
    expect(sql).toContain("overdue_notified_at = NULL");
    expect(params).toEqual(["t4", "org-1", "2026-03-20T00:00:00.000Z"]);

    db.queryOne.mockResolvedValueOnce({ id: "t5", title: "Y", done: true, chat_id: null, due_at: null, assignee_id: null, priority: "normal", created_at: "2026-03-10T00:00:00.000Z" });
    await updateTask("org-1", "t5", { done: true });
    expect((db.queryOne.mock.calls[1] as [string])[0]).not.toContain("overdue_notified_at");
  });

  it("reads the projects lane's `medium` as `normal`", () => {
    expect(normaliseTaskPriority("medium")).toBe("normal");
    expect(normaliseTaskPriority("urgent")).toBe("urgent");
    expect(normaliseTaskPriority(null)).toBe("normal");
    const dto = toTaskDTO({ id: "t6", title: "Z", done: false, chat_id: null, due_at: null, assignee_id: null, priority: "medium", created_at: "2026-03-10T00:00:00.000Z" }, now);
    expect(dto.priority).toBe("normal");
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
