/**
 * Projects end-to-end: quote → project (+ milestones from items) → tasks with
 * assignee/due → log time + expense → budget vs actual → overdue sweep emits
 * task.overdue exactly once → complete milestone (event) → status done
 * (event) → my tasks → v1 (+ 401/403) → archive.
 */
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { api, cleanupDataIds, createTestOrg, describeDb, expectEvent, setScope, sql, type TestOrg } from "./setup";
import type { MilestoneDTO, ProjectBudget, ProjectDTO, ProjectProgress, ProjectTaskDTO } from "@/lib/projects/pure";

vi.mock("@/lib/auth/scope", () => import("./setup").then((m) => m.scopeMockFactory()));
vi.mock("@/lib/supabase/server", () => import("./setup").then((m) => m.supabaseMockFactory()));

type Env<T> = { data: T; meta?: { next_cursor: string | null } };
type Detail = { project: ProjectDTO; progress: ProjectProgress; budget: ProjectBudget; milestones: MilestoneDTO[] };

describeDb("projects flow", () => {
  let org: TestOrg;
  let contactId: string;
  let quoteId: string;
  let project: ProjectDTO;
  let milestones: MilestoneDTO[];
  let lateTask: ProjectTaskDTO;
  let futureTask: ProjectTaskDTO;
  const assignee = "itest-member-ana";

  beforeAll(async () => {
    org = await createTestOrg("projects");
    setScope(org);
    // Lane A's task columns may not be in the base migration yet on this box.
    await sql(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS due_at TIMESTAMPTZ`);
    await sql(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS assignee_id TEXT`);
    await sql(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS priority TEXT`);
  });
  afterAll(async () => {
    await cleanupDataIds([org.dataId]);
  });

  it("401 signed out, 403 for a viewer on write, validation 400", async () => {
    const route = await import("@/app/api/projects/route");
    setScope(null);
    await api(route.GET, "/api/projects", { expect: 401 });
    setScope(org, { role: "viewer", userId: "itest-viewer" });
    await api(route.GET, "/api/projects", { expect: 200 });
    await api(route.POST, "/api/projects", { json: { name: "Nope" }, expect: 403 });
    setScope(org);
    await api(route.POST, "/api/projects", { json: { name: "" }, expect: 400 });
    await api(route.POST, "/api/projects", { json: { name: "X", bogus: 1 }, expect: 400 });
    await api(route.POST, "/api/projects", { json: { name: "X", starts_on: "2026-05-01", due_on: "2026-04-01" }, expect: 400 });
  });

  it("quote → project with milestones from line items", async () => {
    const contacts = await import("@/app/api/crm/contacts/route");
    const c = await api<{ contact: { id: string } }>(contacts.POST, "/api/crm/contacts", { json: { full_name: "Ada Client", email: `ada-${org.slug}@example.test` }, expect: 201 });
    contactId = c.body.contact.id;
    const quotes = await import("@/app/api/quotes/route");
    const q = await api<{ quote: { id: string; total_minor: number; number: string } }>(quotes.POST, "/api/quotes", {
      json: { contact_id: contactId, currency: "USD", items: [{ description: "Design", qty: 1, unit_minor: 50_000, tax_rate_bp: 0 }, { description: "Build", qty: 1, unit_minor: 150_000, tax_rate_bp: 0 }] },
      expect: 201,
    });
    quoteId = q.body.quote.id;
    expect(q.body.quote.total_minor).toBe(200_000);

    const fromQuote = await import("@/app/api/projects/from-quote/route");
    await api(fromQuote.POST, "/api/projects/from-quote", { json: { quoteId: "missing" }, expect: 404 });
    const r = await api<{ project: ProjectDTO; milestones: MilestoneDTO[] }>(fromQuote.POST, "/api/projects/from-quote", { json: { quoteId, due_on: "2026-12-31" }, expect: 201 });
    project = r.body.project;
    milestones = r.body.milestones;
    expect(project.budget_minor).toBe(200_000);
    expect(project.currency).toBe("USD");
    expect(project.contact_id).toBe(contactId);
    expect(project.quote_id).toBe(quoteId);
    expect(project.code).toBe(q.body.quote.number);
    expect(project.status).toBe("planning");
    expect(project.owner_member_id).toBe(org.userId);
    expect(milestones.map((m) => m.name)).toEqual(["Design", "Build"]);
    await expectEvent(org.dataId, "project.created", project.id);

    const list = await api<{ projects: Array<ProjectDTO & { progress: ProjectProgress | null }>; next_cursor: string | null }>((await import("@/app/api/projects/route")).GET, "/api/projects", { query: { summary: 1 }, expect: 200 });
    expect(list.body.projects.map((p) => p.id)).toContain(project.id);
    expect(list.body.projects.find((p) => p.id === project.id)?.progress?.milestones_total).toBe(2);
  });

  it("tasks with assignee + due date; progress counts overdue", async () => {
    const tasks = await import("@/app/api/projects/[id]/tasks/route");
    const yesterday = new Date(Date.now() - 86_400_000).toISOString();
    const nextWeek = new Date(Date.now() + 7 * 86_400_000).toISOString();
    await api(tasks.POST, `/api/projects/${project.id}/tasks`, { json: { title: "Bad", milestone_id: "nope" }, params: { id: project.id }, expect: 400 });
    lateTask = (await api<{ task: ProjectTaskDTO }>(tasks.POST, `/api/projects/${project.id}/tasks`, { json: { title: "Measure site", assignee_id: assignee, due_at: yesterday, priority: "high", estimate_minutes: 120, milestone_id: milestones[0].id }, params: { id: project.id }, expect: 201 })).body.task;
    futureTask = (await api<{ task: ProjectTaskDTO }>(tasks.POST, `/api/projects/${project.id}/tasks`, { json: { title: "Order materials", assignee_id: org.userId, due_at: nextWeek, estimate_minutes: 60, depends_on: [lateTask.id] }, params: { id: project.id }, expect: 201 })).body.task;
    expect(lateTask.project_id).toBe(project.id);
    expect(lateTask.assignee_id).toBe(assignee);
    expect(lateTask.priority).toBe("high");
    expect(futureTask.depends_on).toEqual([lateTask.id]);
    await expectEvent(org.dataId, "task.created", lateTask.id);

    const listed = await api<{ tasks: ProjectTaskDTO[] }>(tasks.GET, `/api/projects/${project.id}/tasks`, { params: { id: project.id }, expect: 200 });
    expect(listed.body.tasks).toHaveLength(2);
    const byAssignee = await api<{ tasks: ProjectTaskDTO[] }>(tasks.GET, `/api/projects/${project.id}/tasks`, { params: { id: project.id }, query: { assignee }, expect: 200 });
    expect(byAssignee.body.tasks.map((t) => t.id)).toEqual([lateTask.id]);

    const detail = await import("@/app/api/projects/[id]/route");
    const d = await api<Detail>(detail.GET, `/api/projects/${project.id}`, { params: { id: project.id }, expect: 200 });
    expect(d.body.progress).toMatchObject({ tasks_total: 2, tasks_done: 0, percent: 0, overdue_tasks: 1, milestones_total: 2, milestones_done: 0, estimate_minutes_total: 180 });
    expect(d.body.progress.next_milestone?.id).toBe(milestones[0].id);
    expect(d.body.progress.days_remaining).toBeGreaterThan(0);

    const timeline = await import("@/app/api/projects/[id]/timeline/route");
    const t = await api<{ timeline: { items: Array<{ kind: string; id: string; overdue: boolean }> } }>(timeline.GET, `/api/projects/${project.id}/timeline`, { params: { id: project.id }, expect: 200 });
    expect(t.body.timeline.items.filter((i) => i.kind === "milestone")).toHaveLength(2);
    expect(t.body.timeline.items.find((i) => i.id === lateTask.id)?.overdue).toBe(true);
  });

  it("time + expense roll into budget vs actual", async () => {
    const time = await import("@/app/api/time/route");
    const started = new Date(Date.now() - 3 * 3_600_000).toISOString();
    // 120 minutes at 60.00/h → 120.00; a second entry without a rate falls back to the project hourly rate (0 here).
    await api(time.POST, "/api/time", { json: { ref_kind: "project", ref_id: project.id, started_at: started, minutes: 120, rate_minor: 6000, currency: "USD", description: "Survey" }, expect: 201 });
    const expenses = await import("@/app/api/expenses/route");
    await api(expenses.POST, "/api/expenses", { json: { category: "materials", amount_minor: 25_000, tax_minor: 5_000, currency: "USD", ref_kind: "project", ref_id: project.id, vendor: "Timber Co" }, expect: 201 });

    const detail = await import("@/app/api/projects/[id]/route");
    const d = await api<Detail>(detail.GET, `/api/projects/${project.id}`, { params: { id: project.id }, expect: 200 });
    expect(d.body.budget).toMatchObject({ currency: "USD", budget_minor: 200_000, time_minutes: 120, time_minor: 12_000, expense_minor: 30_000, actual_minor: 42_000, remaining_minor: 158_000, burn_pct: 21, over_budget: false });

    // Hourly fallback: set a project rate, log time with rate 0.
    await api(detail.PATCH, `/api/projects/${project.id}`, { method: "PATCH", json: { hourly_rate_minor: 10_000, billing_mode: "hourly" }, params: { id: project.id }, expect: 200 });
    await api(time.POST, "/api/time", { json: { ref_kind: "project", ref_id: project.id, started_at: started, minutes: 30, rate_minor: 0, currency: "USD" }, expect: 201 });
    const d2 = await api<Detail>(detail.GET, `/api/projects/${project.id}`, { params: { id: project.id }, expect: 200 });
    expect(d2.body.budget.time_minutes).toBe(150);
    expect(d2.body.budget.time_minor).toBe(17_000); // 12 000 + 30/60 × 10 000
  });

  it("overdue sweep emits task.overdue once per task and is idempotent", async () => {
    const { markOverdueTasks } = await import("@/lib/projects/overdue");
    const first = await markOverdueTasks(500);
    expect(first.notified).toBeGreaterThanOrEqual(1);
    const ev = await expectEvent(org.dataId, "task.overdue", lateTask.id);
    expect(ev).toBeTruthy();
    const second = await markOverdueTasks(500);
    const mine = await sql<{ n: string }>(`SELECT COUNT(*) AS n FROM events WHERE user_id = $1 AND type = 'task.overdue' AND entity_id = $2`, [org.dataId, lateTask.id]);
    expect(Number(mine[0].n)).toBe(1);
    expect(second.notified).toBe(0); // nothing left for this org (or any other row flagged earlier)
    const futureEvents = await sql<{ n: string }>(`SELECT COUNT(*) AS n FROM events WHERE user_id = $1 AND type = 'task.overdue' AND entity_id = $2`, [org.dataId, futureTask.id]);
    expect(Number(futureEvents[0].n)).toBe(0);

    // A new due date resets the flag so a later slip is announced again.
    const taskRoute = await import("@/app/api/projects/tasks/[id]/route");
    const moved = await api<{ task: ProjectTaskDTO }>(taskRoute.PATCH, `/api/projects/tasks/${lateTask.id}`, { method: "PATCH", json: { due_at: new Date(Date.now() - 60_000).toISOString() }, params: { id: lateTask.id }, expect: 200 });
    expect(moved.body.task.id).toBe(lateTask.id);
    const third = await markOverdueTasks(500);
    expect(third.notified).toBeGreaterThanOrEqual(1);
    const again = await sql<{ n: string }>(`SELECT COUNT(*) AS n FROM events WHERE user_id = $1 AND type = 'task.overdue' AND entity_id = $2`, [org.dataId, lateTask.id]);
    expect(Number(again[0].n)).toBe(2);
  });

  it("my tasks, complete milestone (event), status done (event)", async () => {
    setScope(org, { userId: assignee, role: "member" });
    const me = await import("@/app/api/me/tasks/route");
    const mine = await api<{ tasks: ProjectTaskDTO[] }>(me.GET, "/api/me/tasks", { expect: 200 });
    expect(mine.body.tasks.map((t) => t.id)).toEqual([lateTask.id]);
    expect(mine.body.tasks[0].project_name).toBe(project.name);
    setScope(org);

    const taskRoute = await import("@/app/api/projects/tasks/[id]/route");
    await api(taskRoute.PATCH, `/api/projects/tasks/${lateTask.id}`, { method: "PATCH", json: { done: true }, params: { id: lateTask.id }, expect: 200 });
    await api(taskRoute.PATCH, `/api/projects/tasks/missing`, { method: "PATCH", json: { done: true }, params: { id: "missing" }, expect: 404 });

    const ms = await import("@/app/api/projects/milestones/[id]/route");
    const done = await api<{ milestone: MilestoneDTO }>(ms.PATCH, `/api/projects/milestones/${milestones[0].id}`, { method: "PATCH", json: { status: "done" }, params: { id: milestones[0].id }, expect: 200 });
    expect(done.body.milestone.status).toBe("done");
    expect(done.body.milestone.completed_at).toBeTruthy();
    const ev = await expectEvent(org.dataId, "milestone.completed", milestones[0].id);
    expect(ev).toBeTruthy();
    // Completing again is a no-op (no second event).
    await api(ms.PATCH, `/api/projects/milestones/${milestones[0].id}`, { method: "PATCH", json: { status: "done" }, params: { id: milestones[0].id }, expect: 200 });
    const n = await sql<{ n: string }>(`SELECT COUNT(*) AS n FROM events WHERE user_id = $1 AND type = 'milestone.completed' AND entity_id = $2`, [org.dataId, milestones[0].id]);
    expect(Number(n[0].n)).toBe(1);

    const detail = await import("@/app/api/projects/[id]/route");
    const d = await api<Detail>(detail.GET, `/api/projects/${project.id}`, { params: { id: project.id }, expect: 200 });
    expect(d.body.progress).toMatchObject({ tasks_done: 1, percent: 50, overdue_tasks: 0, milestones_done: 1 });
    expect(d.body.progress.next_milestone?.id).toBe(milestones[1].id);

    const updated = await api<{ project: ProjectDTO }>(detail.PATCH, `/api/projects/${project.id}`, { method: "PATCH", json: { status: "done" }, params: { id: project.id }, expect: 200 });
    expect(updated.body.project.status).toBe("done");
    await expectEvent(org.dataId, "project.status_changed", project.id);

    // Members: add, duplicate 409, remove.
    const members = await import("@/app/api/projects/[id]/members/route");
    await api(members.POST, `/api/projects/${project.id}/members`, { json: { role: "member" }, params: { id: project.id }, expect: 400 });
    const m = await api<{ member: { id: string } }>(members.POST, `/api/projects/${project.id}/members`, { json: { member_user_id: assignee, role: "lead" }, params: { id: project.id }, expect: 201 });
    await api(members.POST, `/api/projects/${project.id}/members`, { json: { member_user_id: assignee }, params: { id: project.id }, expect: 409 });
    await api(members.DELETE, `/api/projects/${project.id}/members`, { method: "DELETE", query: { id: m.body.member.id }, params: { id: project.id }, expect: 200 });
    const after = await api<{ members: unknown[] }>(members.GET, `/api/projects/${project.id}/members`, { params: { id: project.id }, expect: 200 });
    expect(after.body.members).toHaveLength(0);
  });

  it("v1: projects list/get/create/patch, milestones, tasks with scopes", async () => {
    setScope(org);
    const keys = await import("@/app/api/api-keys/route");
    const full = await api<{ key: string }>(keys.POST, "/api/api-keys", { json: { name: "projects", scopes: ["write:tasks"] }, expect: 201 });
    const ro = await api<{ key: string }>(keys.POST, "/api/api-keys", { json: { name: "crm only", scopes: ["read:crm"] }, expect: 201 });
    const bearer = (k: string) => ({ authorization: `Bearer ${k}` });

    const v1 = await import("@/app/api/v1/projects/route");
    await api(v1.GET, "/api/v1/projects", { expect: 401 });
    await api(v1.GET, "/api/v1/projects", { headers: bearer(ro.body.key), expect: 403 });
    const list = await api<Env<ProjectDTO[]>>(v1.GET, "/api/v1/projects", { headers: bearer(full.body.key), expect: 200 });
    expect(list.body.data.map((p) => p.id)).toContain(project.id);
    const created = await api<Env<ProjectDTO>>(v1.POST, "/api/v1/projects", { headers: bearer(full.body.key), json: { name: "API project", budget_minor: 5000, currency: "EUR" }, expect: 201 });
    expect(created.body.data.code).toMatch(/^PRJ-\d{3}$/);
    await api(v1.POST, "/api/v1/projects", { headers: bearer(full.body.key), json: { name: "x", due_on: "2020-01-01", starts_on: "2021-01-01" }, expect: 422 });

    const one = await import("@/app/api/v1/projects/[id]/route");
    const got = await api<Env<ProjectDTO>>(one.GET, `/api/v1/projects/${created.body.data.id}`, { headers: bearer(full.body.key), params: { id: created.body.data.id }, expect: 200 });
    expect(got.body.data.currency).toBe("EUR");
    await api(one.GET, `/api/v1/projects/missing`, { headers: bearer(full.body.key), params: { id: "missing" }, expect: 404 });
    const patched = await api<Env<ProjectDTO>>(one.PATCH, `/api/v1/projects/${created.body.data.id}`, { method: "PATCH", headers: bearer(full.body.key), json: { status: "active" }, params: { id: created.body.data.id }, expect: 200 });
    expect(patched.body.data.status).toBe("active");

    const msV1 = await import("@/app/api/v1/projects/[id]/milestones/route");
    const ms = await api<Env<MilestoneDTO>>(msV1.POST, `/api/v1/projects/${created.body.data.id}/milestones`, { headers: bearer(full.body.key), json: { name: "Phase 1", due_on: "2026-09-01" }, params: { id: created.body.data.id }, expect: 201 });
    const msList = await api<Env<MilestoneDTO[]>>(msV1.GET, `/api/v1/projects/${created.body.data.id}/milestones`, { headers: bearer(full.body.key), params: { id: created.body.data.id }, expect: 200 });
    expect(msList.body.data.map((m) => m.id)).toEqual([ms.body.data.id]);

    const tV1 = await import("@/app/api/v1/projects/[id]/tasks/route");
    const t = await api<Env<ProjectTaskDTO>>(tV1.POST, `/api/v1/projects/${created.body.data.id}/tasks`, { headers: bearer(full.body.key), json: { title: "Via API", priority: "low", milestone_id: ms.body.data.id }, params: { id: created.body.data.id }, expect: 201 });
    expect(t.body.data.milestone_id).toBe(ms.body.data.id);
    const tList = await api<Env<ProjectTaskDTO[]>>(tV1.GET, `/api/v1/projects/${created.body.data.id}/tasks`, { headers: bearer(full.body.key), params: { id: created.body.data.id }, query: { done: "false" }, expect: 200 });
    expect(tList.body.data).toHaveLength(1);
  });

  it("archive hides the project from the default list; records pack conversion is idempotent", async () => {
    const detail = await import("@/app/api/projects/[id]/route");
    const a = await api<{ archived: boolean; project: ProjectDTO }>(detail.DELETE, `/api/projects/${project.id}`, { method: "DELETE", params: { id: project.id }, expect: 200 });
    expect(a.body.project.archived_at).toBeTruthy();
    const list = await import("@/app/api/projects/route");
    const visible = await api<{ projects: ProjectDTO[] }>(list.GET, "/api/projects", { expect: 200 });
    expect(visible.body.projects.map((p) => p.id)).not.toContain(project.id);
    const all = await api<{ projects: ProjectDTO[] }>(list.GET, "/api/projects", { query: { archived: 1 }, expect: 200 });
    expect(all.body.projects.map((p) => p.id)).toContain(project.id);

    // Records "projects" pack → first-class project.
    const packs = await import("@/app/api/records/packs/route");
    await api(packs.POST, "/api/records/packs", { json: { slug: "projects" }, expect: [200, 201] });
    const records = await import("@/app/api/records/[type]/route");
    const rec = await api<{ record: { id: string } }>(records.POST, "/api/records/projects", { json: { title: "Garden wall", data: { budget: 1200, due_on: "2026-08-01", priority: "High" } }, params: { type: "projects" }, expect: 201 });
    const fromRecord = await import("@/app/api/projects/from-record/route");
    const c1 = await api<{ project: ProjectDTO; alreadyConverted: boolean }>(fromRecord.POST, "/api/projects/from-record", { json: { recordId: rec.body.record.id }, expect: 201 });
    expect(c1.body.project.name).toBe("Garden wall");
    expect(c1.body.project.budget_minor).toBe(120_000);
    expect(c1.body.project.due_on).toBe("2026-08-01");
    const c2 = await api<{ project: ProjectDTO; alreadyConverted: boolean }>(fromRecord.POST, "/api/projects/from-record", { json: { recordId: rec.body.record.id }, expect: 200 });
    expect(c2.body.alreadyConverted).toBe(true);
    expect(c2.body.project.id).toBe(c1.body.project.id);
  });
});
