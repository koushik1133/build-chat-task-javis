import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * SEC: project member / assignee ids are validated against the workspace,
 * contact joins are tenant-safe, and the overdue sweep's claim repeats the
 * selection predicate so a re-dated task is never stamped.
 */
const db = vi.hoisted(() => ({
  query: vi.fn<(sql: string, values?: unknown[]) => Promise<unknown[]>>(async () => []),
  queryOne: vi.fn<(sql: string, values?: unknown[]) => Promise<unknown>>(async () => null),
  withRetry: vi.fn(async <T,>(fn: () => Promise<T>) => fn()),
}));
vi.mock("@/lib/dsql", () => db);
vi.mock("@/lib/events/bus", () => ({ emitEvent: vi.fn(async () => undefined) }));
vi.mock("@/lib/table-exists", () => ({ tableExists: vi.fn(async () => true) }));

import { isWorkspaceMember } from "@/lib/auth/members";
import { addMember, createProjectTask, PROJECT_FROM, updateProject } from "@/lib/projects/store";
import { ProjectError } from "@/lib/projects/pure";
import { markOverdueTasks } from "@/lib/projects/overdue";
import { createTask, TaskInputError } from "@/lib/tasks/store";

const project = { id: "p1", name: "P", code: "PRJ-001", description_md: null, contact_id: null, contact_name: null, quote_id: null, status: "active", starts_on: null, due_on: null, budget_minor: 0, currency: "USD", billing_mode: "fixed", hourly_rate_minor: 0, owner_member_id: null, color: null, archived_at: null, created_at: "2026-01-01", updated_at: "2026-01-01" };

describe("workspace member validation", () => {
  beforeEach(() => {
    db.query.mockReset();
    db.queryOne.mockReset();
  });

  it("isWorkspaceMember: owner is always a member; others need an active membership of this org", async () => {
    expect(await isWorkspaceMember("org", "org")).toBe(true);
    db.queryOne.mockResolvedValueOnce(null);
    expect(await isWorkspaceMember("org", "stranger")).toBe(false);
    const [sql, params] = db.queryOne.mock.calls[0];
    expect(sql).toMatch(/o\.owner_user_id = \$1 AND m\.user_id = \$2 AND m\.status = 'active'/);
    expect(params).toEqual(["org", "stranger"]);
  });

  it("addMember refuses a user id from another org", async () => {
    db.queryOne.mockImplementation(async (sql: string) => (sql.includes("FROM projects p") ? project : null));
    await expect(addMember("org", "p1", { member_user_id: "other-org-user", staff_id: null, role: "member" })).rejects.toThrow(ProjectError);
    expect(db.query.mock.calls.some(([sql]) => sql.includes("INSERT INTO project_members"))).toBe(false);
  });

  it("createProjectTask / createTask refuse a foreign assignee", async () => {
    db.queryOne.mockImplementation(async (sql: string) => (sql.includes("FROM projects p") ? project : null));
    await expect(createProjectTask("org", "p1", { title: "t", assignee_id: "ghost" })).rejects.toThrow(/assignee_id is not a member/);
    await expect(createTask("org", { title: "t", assignee_id: "ghost" })).rejects.toThrow(TaskInputError);
    expect(db.queryOne.mock.calls.some(([sql]) => sql.includes("INSERT INTO tasks"))).toBe(false);
  });

  it("updateProject validates a new contact_id against the org", async () => {
    db.queryOne.mockImplementation(async (sql: string) => (sql.includes("FROM projects p") ? project : null));
    await expect(updateProject("org", "p1", { contact_id: "foreign-contact" })).rejects.toThrow(/contact_id does not exist/);
  });

  it("project/contact join is tenant-safe", () => {
    expect(PROJECT_FROM).toContain("c.user_id = p.user_id");
  });
});

describe("overdue sweep claim", () => {
  it("re-checks due_at and deleted_at in the UPDATE so a re-dated task is not stamped", async () => {
    db.query.mockReset();
    db.query.mockImplementation(async (sql: string) => (sql.startsWith("SELECT") ? [{ id: "t1", user_id: "org" }] : []));
    const out = await markOverdueTasks(10, new Date("2026-02-01T00:00:00Z"));
    expect(out.notified).toBe(0);
    const upd = db.query.mock.calls.find(([sql]) => sql.includes("UPDATE tasks SET overdue_notified_at"));
    expect(upd?.[0]).toMatch(/deleted_at IS NULL AND due_at IS NOT NULL AND due_at < \$2 AND overdue_notified_at IS NULL/);
    expect(upd?.[1]).toEqual(["t1", "2026-02-01T00:00:00.000Z"]);
  });
});
