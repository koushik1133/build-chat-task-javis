import { randomUUID } from "crypto";
import { query, queryOne } from "@/lib/dsql";
import { emitEvent } from "@/lib/events/bus";
import { isWorkspaceMember } from "@/lib/auth/members";
import { keysetClause, keysetOrder, type Cursor } from "@/lib/public-api/pagination";
import {
  ProjectError,
  normaliseTaskPriority,
  parseDependsOn,
  type MilestoneDTO,
  type MilestoneInput,
  type MilestonePatch,
  type ProjectDTO,
  type ProjectInput,
  type ProjectMemberDTO,
  type ProjectMemberInput,
  type ProjectPatch,
  type ProjectStatus,
  type ProjectTaskDTO,
  type ProjectTaskInput,
  type ProjectTaskPatch,
} from "./pure";
import { updateInBatches } from "@/lib/db/batch";

/**
 * Projects data layer: projects, milestones, members and the project view of
 * the shared `tasks` table. Every query is keyed by `user_id = dataId`.
 * Lane A owns `tasks.due_at / assignee_id / priority` — this module only reads
 * and writes those columns by name.
 */

/* ─── rows ───────────────────────────────────────────────────────────────── */

interface ProjectRow {
  id: string;
  name: string;
  code: string | null;
  description_md: string | null;
  contact_id: string | null;
  contact_name: string | null;
  quote_id: string | null;
  status: ProjectStatus;
  starts_on: string | null;
  due_on: string | null;
  budget_minor: string | number;
  currency: string;
  billing_mode: ProjectDTO["billing_mode"];
  hourly_rate_minor: string | number;
  owner_member_id: string | null;
  color: string | null;
  archived_at: string | Date | null;
  created_at: string | Date;
  updated_at: string | Date;
}

interface MilestoneRow {
  id: string;
  project_id: string;
  name: string;
  due_on: string | null;
  status: MilestoneDTO["status"];
  sort: number | string;
  completed_at: string | Date | null;
  created_at: string | Date;
}

interface MemberRow {
  id: string;
  project_id: string;
  member_user_id: string | null;
  staff_id: string | null;
  role: ProjectMemberDTO["role"];
  created_at: string | Date;
}

interface TaskRow {
  id: string;
  title: string;
  done: boolean;
  project_id: string | null;
  milestone_id: string | null;
  assignee_id: string | null;
  due_at: string | Date | null;
  priority: string | null;
  estimate_minutes: number | string | null;
  sort: number | string | null;
  depends_on: string | null;
  created_at: string | Date;
  project_name?: string | null;
  project_color?: string | null;
}

const iso = (v: string | Date | null | undefined): string | null => (v == null ? null : v instanceof Date ? v.toISOString() : String(v));
const num = (v: string | number | null | undefined): number => Number(v) || 0;

export const PROJECT_COLS = `p.id, p.name, p.code, p.description_md, p.contact_id, c.full_name AS contact_name, p.quote_id, p.status, p.starts_on::text AS starts_on, p.due_on::text AS due_on,
  p.budget_minor, p.currency, p.billing_mode, p.hourly_rate_minor, p.owner_member_id, p.color, p.archived_at, p.created_at, p.updated_at`;
export const PROJECT_FROM = `FROM projects p LEFT JOIN crm_contacts c ON c.id = p.contact_id AND c.user_id = p.user_id`;

export const TASK_COLS = `t.id::text AS id, t.title, t.done, t.project_id, t.milestone_id, t.assignee_id, t.due_at, t.priority, t.estimate_minutes, t.sort, t.depends_on, t.created_at`;

export function toProjectDTO(r: ProjectRow): ProjectDTO {
  return {
    id: r.id,
    name: r.name,
    code: r.code,
    description_md: r.description_md,
    contact_id: r.contact_id,
    contact_name: r.contact_name ?? null,
    quote_id: r.quote_id,
    status: r.status,
    starts_on: r.starts_on,
    due_on: r.due_on,
    budget_minor: num(r.budget_minor),
    currency: r.currency,
    billing_mode: r.billing_mode,
    hourly_rate_minor: num(r.hourly_rate_minor),
    owner_member_id: r.owner_member_id,
    color: r.color,
    archived_at: iso(r.archived_at),
    created_at: iso(r.created_at) as string,
    updated_at: iso(r.updated_at) as string,
  };
}

export function toMilestoneDTO(r: MilestoneRow): MilestoneDTO {
  return { id: r.id, project_id: r.project_id, name: r.name, due_on: r.due_on, status: r.status, sort: num(r.sort), completed_at: iso(r.completed_at), created_at: iso(r.created_at) as string };
}

export function toMemberDTO(r: MemberRow): ProjectMemberDTO {
  return { id: r.id, project_id: r.project_id, member_user_id: r.member_user_id, staff_id: r.staff_id, role: r.role, created_at: iso(r.created_at) as string };
}

export function toProjectTaskDTO(r: TaskRow): ProjectTaskDTO {
  return {
    id: String(r.id),
    title: r.title,
    done: Boolean(r.done),
    project_id: r.project_id,
    milestone_id: r.milestone_id,
    assignee_id: r.assignee_id,
    due_at: iso(r.due_at),
    priority: normaliseTaskPriority(r.priority),
    estimate_minutes: r.estimate_minutes == null ? null : Number(r.estimate_minutes),
    sort: r.sort == null ? null : Number(r.sort),
    depends_on: parseDependsOn(r.depends_on),
    created_at: iso(r.created_at) as string,
    ...(r.project_name !== undefined ? { project_name: r.project_name } : {}),
    ...(r.project_color !== undefined ? { project_color: r.project_color } : {}),
  };
}

/* ─── projects ───────────────────────────────────────────────────────────── */

export interface ListProjectsOpts {
  status?: ProjectStatus | null;
  /** Server-side open filter: planning, active, on_hold. Ignored when status is set. */
  open?: boolean;
  includeArchived?: boolean;
  q?: string | null;
  limit?: number;
  cursor?: Cursor | null;
}

export async function listProjects(dataId: string, opts: ListProjectsOpts = {}): Promise<ProjectDTO[]> {
  const params: unknown[] = [dataId];
  let sql = `SELECT ${PROJECT_COLS} ${PROJECT_FROM} WHERE p.user_id = $1`;
  if (!opts.includeArchived) sql += ` AND p.archived_at IS NULL`;
  if (opts.status) {
    params.push(opts.status);
    sql += ` AND p.status = $${params.length}`;
  } else if (opts.open) {
    sql += ` AND p.status IN ('planning', 'active', 'on_hold')`;
  }
  if (opts.q?.trim()) {
    params.push(`%${opts.q.trim().toLowerCase()}%`);
    sql += ` AND (LOWER(p.name) LIKE $${params.length} OR LOWER(COALESCE(p.code, '')) LIKE $${params.length})`;
  }
  sql += keysetClause(opts.cursor, params, { alias: "p." });
  params.push(Math.min(Math.max(opts.limit ?? 50, 1), 200));
  sql += ` ORDER BY ${keysetOrder("p.")} LIMIT $${params.length}`;
  return (await query<ProjectRow>(sql, params)).map(toProjectDTO);
}

export async function getProject(dataId: string, id: string): Promise<ProjectDTO | null> {
  const row = await queryOne<ProjectRow>(`SELECT ${PROJECT_COLS} ${PROJECT_FROM} WHERE p.id = $1 AND p.user_id = $2`, [id, dataId]);
  return row ? toProjectDTO(row) : null;
}

export async function requireProject(dataId: string, id: string): Promise<ProjectDTO> {
  const p = await getProject(dataId, id);
  if (!p) throw new ProjectError("Project not found", 404);
  return p;
}

async function nextCode(dataId: string): Promise<string> {
  const r = await queryOne<{ n: string | number }>(`SELECT COUNT(*) AS n FROM projects WHERE user_id = $1`, [dataId]);
  return `PRJ-${String(num(r?.n) + 1).padStart(3, "0")}`;
}

async function assertContact(dataId: string, contactId: string | null | undefined): Promise<void> {
  if (!contactId) return;
  const c = await queryOne<{ id: string }>(`SELECT id FROM crm_contacts WHERE id = $1 AND user_id = $2`, [contactId, dataId]);
  if (!c) throw new ProjectError("contact_id does not exist");
}

/** A member/assignee id must be the org owner or an active member of this workspace; anything else is refused. */
export async function assertWorkspaceMember(dataId: string, userId: string | null | undefined, field = "assignee_id"): Promise<void> {
  if (!userId) return;
  if (!(await isWorkspaceMember(dataId, userId))) throw new ProjectError(`${field} is not a member of this workspace`);
}

export async function createProject(dataId: string, input: ProjectInput, actorId?: string | null): Promise<ProjectDTO> {
  if (input.starts_on && input.due_on && input.due_on < input.starts_on) throw new ProjectError("due_on must be on or after starts_on");
  await assertContact(dataId, input.contact_id);
  await assertWorkspaceMember(dataId, input.owner_member_id, "owner_member_id");
  const id = randomUUID();
  const code = input.code?.trim() || (await nextCode(dataId));
  await query(
    `INSERT INTO projects (id, user_id, name, code, description_md, contact_id, quote_id, status, starts_on, due_on, budget_minor, currency, billing_mode, hourly_rate_minor, owner_member_id, color)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
    [
      id, dataId, input.name, code, input.description_md ?? null, input.contact_id ?? null, input.quote_id ?? null, input.status,
      input.starts_on ?? null, input.due_on ?? null, input.budget_minor, input.currency, input.billing_mode, input.hourly_rate_minor,
      input.owner_member_id ?? actorId ?? null, input.color ?? null,
    ]
  );
  const p = await requireProject(dataId, id);
  void emitEvent(dataId, { type: "project.created", entity: "project", entityId: id, data: { name: p.name, code: p.code, status: p.status, contact_id: p.contact_id, quote_id: p.quote_id, budget_minor: p.budget_minor, currency: p.currency } });
  return p;
}

export async function updateProject(dataId: string, id: string, patch: ProjectPatch): Promise<ProjectDTO> {
  const before = await requireProject(dataId, id);
  const sets: string[] = [];
  const params: unknown[] = [id, dataId];
  const set = (col: string, v: unknown) => {
    params.push(v);
    sets.push(`${col} = $${params.length}`);
  };
  for (const [k, v] of Object.entries(patch) as Array<[keyof ProjectPatch, unknown]>) {
    if (v === undefined) continue;
    set(k, v);
  }
  const starts = patch.starts_on === undefined ? before.starts_on : patch.starts_on;
  const due = patch.due_on === undefined ? before.due_on : patch.due_on;
  if (starts && due && due < starts) throw new ProjectError("due_on must be on or after starts_on");
  await assertContact(dataId, patch.contact_id);
  await assertWorkspaceMember(dataId, patch.owner_member_id, "owner_member_id");
  if (sets.length === 0) return before;
  sets.push(`updated_at = NOW()`);
  await query(`UPDATE projects SET ${sets.join(", ")} WHERE id = $1 AND user_id = $2`, params);
  const after = await requireProject(dataId, id);
  if (patch.status && patch.status !== before.status) {
    void emitEvent(dataId, { type: "project.status_changed", entity: "project", entityId: id, data: { name: after.name, from: before.status, to: after.status, contact_id: after.contact_id } });
  }
  return after;
}

/** DELETE = archive (history is kept). */
export async function archiveProject(dataId: string, id: string): Promise<ProjectDTO> {
  await requireProject(dataId, id);
  await query(`UPDATE projects SET archived_at = COALESCE(archived_at, NOW()), updated_at = NOW() WHERE id = $1 AND user_id = $2`, [id, dataId]);
  return requireProject(dataId, id);
}

/* ─── milestones ─────────────────────────────────────────────────────────── */

export async function listMilestones(dataId: string, projectId: string): Promise<MilestoneDTO[]> {
  const rows = await query<MilestoneRow>(
    `SELECT id, project_id, name, due_on::text AS due_on, status, sort, completed_at, created_at FROM project_milestones WHERE user_id = $1 AND project_id = $2 ORDER BY sort ASC, due_on ASC NULLS LAST, created_at ASC`,
    [dataId, projectId]
  );
  return rows.map(toMilestoneDTO);
}

export async function getMilestone(dataId: string, id: string): Promise<MilestoneDTO | null> {
  const row = await queryOne<MilestoneRow>(`SELECT id, project_id, name, due_on::text AS due_on, status, sort, completed_at, created_at FROM project_milestones WHERE id = $1 AND user_id = $2`, [id, dataId]);
  return row ? toMilestoneDTO(row) : null;
}

export async function createMilestone(dataId: string, projectId: string, input: MilestoneInput): Promise<MilestoneDTO> {
  await requireProject(dataId, projectId);
  const id = randomUUID();
  let sort = input.sort;
  if (sort === undefined) {
    const r = await queryOne<{ m: number | string | null }>(`SELECT MAX(sort) AS m FROM project_milestones WHERE user_id = $1 AND project_id = $2`, [dataId, projectId]);
    sort = r?.m == null ? 0 : Number(r.m) + 1;
  }
  await query(`INSERT INTO project_milestones (id, user_id, project_id, name, due_on, status, sort) VALUES ($1, $2, $3, $4, $5, 'open', $6)`, [id, dataId, projectId, input.name, input.due_on ?? null, sort]);
  const m = await getMilestone(dataId, id);
  if (!m) throw new Error("Milestone vanished after insert");
  return m;
}

export async function updateMilestone(dataId: string, id: string, patch: MilestonePatch): Promise<MilestoneDTO> {
  const before = await getMilestone(dataId, id);
  if (!before) throw new ProjectError("Milestone not found", 404);
  const sets: string[] = [];
  const params: unknown[] = [id, dataId];
  const set = (col: string, v: unknown) => {
    params.push(v);
    sets.push(`${col} = $${params.length}`);
  };
  if (patch.name !== undefined) set("name", patch.name);
  if (patch.due_on !== undefined) set("due_on", patch.due_on);
  if (patch.sort !== undefined) set("sort", patch.sort);
  if (patch.status !== undefined && patch.status !== before.status) {
    set("status", patch.status);
    sets.push(patch.status === "done" ? `completed_at = NOW()` : `completed_at = NULL`);
  }
  if (sets.length === 0) return before;
  await query(`UPDATE project_milestones SET ${sets.join(", ")} WHERE id = $1 AND user_id = $2`, params);
  const after = (await getMilestone(dataId, id)) as MilestoneDTO;
  if (patch.status === "done" && before.status !== "done") {
    const project = await getProject(dataId, after.project_id);
    const contact = project?.contact_id ? await queryOne<{ email: string | null }>(`SELECT email FROM crm_contacts WHERE id = $1 AND user_id = $2`, [project.contact_id, dataId]).catch(() => null) : null;
    void emitEvent(dataId, {
      type: "milestone.completed",
      entity: "project_milestone",
      entityId: id,
      data: { name: after.name, project_id: after.project_id, project_name: project?.name ?? null, contact_id: project?.contact_id ?? null, contact_email: contact?.email ?? null, due_on: after.due_on },
    });
  }
  return after;
}

export async function deleteMilestone(dataId: string, id: string): Promise<boolean> {
  const rows = await query<{ id: string }>(`DELETE FROM project_milestones WHERE id = $1 AND user_id = $2 RETURNING id`, [id, dataId]);
  if (rows.length > 0) await updateInBatches("tasks", "milestone_id = NULL", "user_id = $1 AND milestone_id = $2", [dataId, id]);
  return rows.length > 0;
}

/* ─── members ────────────────────────────────────────────────────────────── */

export async function listMembers(dataId: string, projectId: string): Promise<ProjectMemberDTO[]> {
  const rows = await query<MemberRow>(`SELECT id, project_id, member_user_id, staff_id, role, created_at FROM project_members WHERE user_id = $1 AND project_id = $2 ORDER BY created_at ASC`, [dataId, projectId]);
  return rows.map(toMemberDTO);
}

export async function addMember(dataId: string, projectId: string, input: ProjectMemberInput): Promise<ProjectMemberDTO> {
  await requireProject(dataId, projectId);
  if (input.staff_id) {
    const s = await queryOne<{ id: string }>(`SELECT id FROM staff_profiles WHERE id = $1 AND user_id = $2`, [input.staff_id, dataId]).catch(() => null);
    if (!s) throw new ProjectError("staff_id does not exist");
  }
  await assertWorkspaceMember(dataId, input.member_user_id, "member_user_id");
  const dup = await queryOne<{ id: string }>(
    `SELECT id FROM project_members WHERE user_id = $1 AND project_id = $2 AND ((member_user_id IS NOT NULL AND member_user_id = $3) OR (staff_id IS NOT NULL AND staff_id = $4)) LIMIT 1`,
    [dataId, projectId, input.member_user_id ?? null, input.staff_id ?? null]
  );
  if (dup) throw new ProjectError("Already a member of this project", 409);
  const id = randomUUID();
  await query(`INSERT INTO project_members (id, user_id, project_id, member_user_id, staff_id, role) VALUES ($1, $2, $3, $4, $5, $6)`, [id, dataId, projectId, input.member_user_id ?? null, input.staff_id ?? null, input.role]);
  const row = await queryOne<MemberRow>(`SELECT id, project_id, member_user_id, staff_id, role, created_at FROM project_members WHERE id = $1`, [id]);
  if (!row) throw new Error("Member vanished after insert");
  return toMemberDTO(row);
}

export async function removeMember(dataId: string, projectId: string, id: string): Promise<boolean> {
  const rows = await query<{ id: string }>(`DELETE FROM project_members WHERE id = $1 AND user_id = $2 AND project_id = $3 RETURNING id`, [id, dataId, projectId]);
  return rows.length > 0;
}

/* ─── tasks (project view) ───────────────────────────────────────────────── */

export interface ListProjectTasksOpts {
  done?: boolean | null;
  milestoneId?: string | null;
  assigneeId?: string | null;
  limit?: number;
}

export async function listProjectTasks(dataId: string, projectId: string, opts: ListProjectTasksOpts = {}): Promise<ProjectTaskDTO[]> {
  const params: unknown[] = [dataId, projectId];
  let sql = `SELECT ${TASK_COLS} FROM tasks t WHERE t.user_id = $1 AND t.project_id = $2 AND t.deleted_at IS NULL`;
  if (opts.done === true || opts.done === false) {
    params.push(opts.done);
    sql += ` AND t.done = $${params.length}`;
  }
  if (opts.milestoneId) {
    params.push(opts.milestoneId);
    sql += ` AND t.milestone_id = $${params.length}`;
  }
  if (opts.assigneeId) {
    params.push(opts.assigneeId);
    sql += ` AND t.assignee_id = $${params.length}`;
  }
  params.push(Math.min(Math.max(opts.limit ?? 500, 1), 1000));
  sql += ` ORDER BY t.done ASC, t.sort ASC NULLS LAST, t.due_at ASC NULLS LAST, t.created_at ASC LIMIT $${params.length}`;
  return (await query<TaskRow>(sql, params)).map(toProjectTaskDTO);
}

export async function getProjectTask(dataId: string, id: string): Promise<ProjectTaskDTO | null> {
  const row = await queryOne<TaskRow>(`SELECT ${TASK_COLS} FROM tasks t WHERE t.id::text = $1 AND t.user_id = $2 AND t.deleted_at IS NULL`, [id, dataId]);
  return row ? toProjectTaskDTO(row) : null;
}

async function assertMilestone(dataId: string, projectId: string, milestoneId: string | null | undefined): Promise<void> {
  if (!milestoneId) return;
  const m = await getMilestone(dataId, milestoneId);
  if (!m || m.project_id !== projectId) throw new ProjectError("milestone_id does not belong to this project");
}

export async function createProjectTask(dataId: string, projectId: string, input: ProjectTaskInput, opts: { source?: string } = {}): Promise<ProjectTaskDTO> {
  await requireProject(dataId, projectId);
  await assertMilestone(dataId, projectId, input.milestone_id);
  await assertWorkspaceMember(dataId, input.assignee_id);
  const row = await queryOne<TaskRow>(
    `INSERT INTO tasks (user_id, title, project_id, milestone_id, assignee_id, due_at, priority, estimate_minutes, sort, depends_on)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id::text AS id, title, done, project_id, milestone_id, assignee_id, due_at, priority, estimate_minutes, sort, depends_on, created_at`,
    [dataId, input.title, projectId, input.milestone_id ?? null, input.assignee_id ?? null, input.due_at ?? null, input.priority ?? null, input.estimate_minutes ?? null, input.sort ?? null, input.depends_on ? JSON.stringify(input.depends_on) : null]
  );
  if (!row) throw new Error("Insert returned no row");
  void emitEvent(dataId, { type: "task.created", entity: "task", entityId: row.id, data: { title: row.title, project_id: projectId, assignee_id: row.assignee_id, due_at: iso(row.due_at), source: opts.source ?? "project" } });
  return toProjectTaskDTO(row);
}

export async function updateProjectTask(dataId: string, id: string, patch: ProjectTaskPatch): Promise<ProjectTaskDTO> {
  const before = await getProjectTask(dataId, id);
  if (!before) throw new ProjectError("Task not found", 404);
  const projectId = patch.project_id === undefined ? before.project_id : patch.project_id;
  // Moving a task into a project: the target must belong to this org.
  if (patch.project_id && patch.project_id !== before.project_id) await requireProject(dataId, patch.project_id);
  if (patch.milestone_id && projectId) await assertMilestone(dataId, projectId, patch.milestone_id);
  await assertWorkspaceMember(dataId, patch.assignee_id);
  const sets: string[] = [];
  const params: unknown[] = [id, dataId];
  const set = (col: string, v: unknown) => {
    params.push(v);
    sets.push(`${col} = $${params.length}`);
  };
  if (patch.title !== undefined) set("title", patch.title);
  if (patch.done !== undefined) set("done", patch.done);
  if (patch.project_id !== undefined) set("project_id", patch.project_id);
  if (patch.milestone_id !== undefined) set("milestone_id", patch.milestone_id);
  if (patch.assignee_id !== undefined) set("assignee_id", patch.assignee_id);
  if (patch.due_at !== undefined) {
    set("due_at", patch.due_at);
    // A new deadline gets a fresh overdue notice.
    sets.push(`overdue_notified_at = NULL`);
  }
  if (patch.priority !== undefined) set("priority", patch.priority);
  if (patch.estimate_minutes !== undefined) set("estimate_minutes", patch.estimate_minutes);
  if (patch.sort !== undefined) set("sort", patch.sort);
  if (patch.depends_on !== undefined) set("depends_on", JSON.stringify(patch.depends_on));
  if (sets.length === 0) return before;
  await query(`UPDATE tasks SET ${sets.join(", ")} WHERE id::text = $1 AND user_id = $2`, params);
  return (await getProjectTask(dataId, id)) as ProjectTaskDTO;
}

/** Default "my tasks" view: open tasks assigned to a member across projects, soonest due first. */
export async function tasksForMember(dataId: string, memberUserId: string, opts: { includeDone?: boolean; limit?: number } = {}): Promise<ProjectTaskDTO[]> {
  const params: unknown[] = [dataId, memberUserId];
  let sql = `SELECT ${TASK_COLS}, p.name AS project_name, p.color AS project_color
      FROM tasks t LEFT JOIN projects p ON p.id = t.project_id AND p.user_id = t.user_id
     WHERE t.user_id = $1 AND t.assignee_id = $2 AND t.deleted_at IS NULL`;
  if (!opts.includeDone) sql += ` AND t.done = FALSE`;
  params.push(Math.min(Math.max(opts.limit ?? 200, 1), 500));
  sql += ` ORDER BY t.done ASC, t.due_at ASC NULLS LAST, CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'normal' THEN 2 ELSE 3 END, t.created_at ASC LIMIT $${params.length}`;
  return (await query<TaskRow>(sql, params)).map(toProjectTaskDTO);
}
