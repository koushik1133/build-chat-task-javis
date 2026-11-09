import { query, queryOne } from "@/lib/dsql";
import { emitEvent } from "@/lib/events/bus";
import { keysetClause, keysetOrder, type Cursor } from "@/lib/public-api/pagination";

/**
 * Tasks data layer shared by the in-app route and the public API. Emits
 * `task.created` on insert. Phase 8 added `due_at`, `assignee_id` (a member
 * user id) and `priority` (low|normal|high|urgent); Projects build on these
 * exact column names.
 */

export const TASK_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];
export function isTaskPriority(v: unknown): v is TaskPriority {
  return typeof v === "string" && (TASK_PRIORITIES as readonly string[]).includes(v);
}

export interface TaskRow {
  id: string;
  title: string;
  done: boolean;
  chat_id: string | null;
  due_at: string | Date | null;
  assignee_id: string | null;
  priority: string | null;
  created_at: string | Date;
}

export interface TaskDTO {
  id: string;
  title: string;
  done: boolean;
  chat_id: string | null;
  due_at: string | null;
  assignee_id: string | null;
  priority: TaskPriority;
  /** True when open and past due (computed server side so clients agree with the home tile). */
  overdue: boolean;
  created_at: string;
}

/**
 * `tasks.created_at` is TIMESTAMP (no zone); read it through `AT TIME ZONE 'UTC'`
 * so cursors (ISO/UTC) and the column compare in the same frame.
 */
export const TASK_TS = "(created_at AT TIME ZONE 'UTC')";
const COLS = `id::text AS id, title, done, chat_id::text AS chat_id, due_at, assignee_id, priority, ${TASK_TS} AS created_at`;

function iso(v: string | Date | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

/** Pure: open + due in the past. */
export function isOverdue(t: { done: boolean; due_at: string | Date | null }, now: Date = new Date()): boolean {
  if (t.done || !t.due_at) return false;
  const due = t.due_at instanceof Date ? t.due_at.getTime() : Date.parse(t.due_at);
  return Number.isFinite(due) && due < now.getTime();
}

export function toTaskDTO(r: TaskRow, now: Date = new Date()): TaskDTO {
  return {
    id: String(r.id),
    title: r.title,
    done: Boolean(r.done),
    chat_id: r.chat_id,
    due_at: iso(r.due_at),
    assignee_id: r.assignee_id ?? null,
    priority: isTaskPriority(r.priority) ? r.priority : "normal",
    overdue: isOverdue(r, now),
    created_at: iso(r.created_at) ?? String(r.created_at),
  };
}

export interface ListTasksOpts {
  done?: boolean | null;
  assigneeId?: string | null;
  overdue?: boolean;
  limit?: number;
  cursor?: Cursor | null;
}

export async function listTasks(dataId: string, opts: ListTasksOpts = {}): Promise<TaskDTO[]> {
  const params: unknown[] = [dataId];
  let sql = `SELECT ${COLS} FROM tasks WHERE user_id = $1`;
  if (opts.done === true || opts.done === false) {
    params.push(opts.done);
    sql += ` AND done = $${params.length}`;
  }
  if (opts.assigneeId) {
    params.push(opts.assigneeId);
    sql += ` AND assignee_id = $${params.length}`;
  }
  if (opts.overdue) sql += ` AND done = FALSE AND due_at IS NOT NULL AND due_at < NOW()`;
  sql += keysetClause(opts.cursor, params, { col: TASK_TS });
  params.push(Math.min(Math.max(opts.limit ?? 50, 1), 501));
  sql += ` ORDER BY ${keysetOrder("", TASK_TS)} LIMIT $${params.length}`;
  return (await query<TaskRow>(sql, params)).map((r) => toTaskDTO(r));
}

export async function getTask(dataId: string, id: string): Promise<TaskDTO | null> {
  const row = await queryOne<TaskRow>(`SELECT ${COLS} FROM tasks WHERE id::text = $1 AND user_id = $2`, [id, dataId]);
  return row ? toTaskDTO(row) : null;
}

export interface TaskCreateInput {
  title: string;
  due_at?: string | null;
  assignee_id?: string | null;
  priority?: TaskPriority | null;
  chat_id?: string | null;
}

export async function createTask(dataId: string, input: TaskCreateInput, source: string = "api"): Promise<TaskDTO> {
  const row = await queryOne<TaskRow>(
    `INSERT INTO tasks (user_id, title, due_at, assignee_id, priority, chat_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${COLS}`,
    [dataId, input.title.trim(), input.due_at ?? null, input.assignee_id ?? null, input.priority ?? "normal", input.chat_id ?? null]
  );
  if (!row) throw new Error("Insert returned no row");
  void emitEvent(dataId, {
    type: "task.created",
    entity: "task",
    entityId: String(row.id),
    data: { title: row.title, source, due_at: iso(row.due_at), assignee_id: row.assignee_id ?? null, priority: row.priority ?? "normal" },
  });
  return toTaskDTO(row);
}

export interface TaskPatchInput {
  title?: string;
  done?: boolean;
  due_at?: string | null;
  assignee_id?: string | null;
  priority?: TaskPriority;
}

export async function updateTask(dataId: string, id: string, patch: TaskPatchInput): Promise<TaskDTO> {
  const sets: string[] = [];
  const params: unknown[] = [id, dataId];
  const set = (col: string, v: unknown) => {
    params.push(v);
    sets.push(`${col} = $${params.length}`);
  };
  if (patch.title !== undefined) set("title", patch.title.trim());
  if (patch.done !== undefined) set("done", patch.done);
  if (patch.due_at !== undefined) set("due_at", patch.due_at);
  if (patch.assignee_id !== undefined) set("assignee_id", patch.assignee_id);
  if (patch.priority !== undefined) set("priority", patch.priority);
  if (sets.length === 0) {
    const current = await getTask(dataId, id);
    if (!current) throw new Error("Task not found");
    return current;
  }
  const row = await queryOne<TaskRow>(`UPDATE tasks SET ${sets.join(", ")} WHERE id::text = $1 AND user_id = $2 RETURNING ${COLS}`, params);
  if (!row) throw new Error("Task not found");
  return toTaskDTO(row);
}

export async function deleteTask(dataId: string, id: string): Promise<boolean> {
  const rows = await query<{ id: string }>(`DELETE FROM tasks WHERE id::text = $1 AND user_id = $2 RETURNING id::text AS id`, [id, dataId]);
  return rows.length > 0;
}

/** Open tasks past their due date (home tile). */
export async function countOverdueTasks(dataId: string, now: Date = new Date()): Promise<number> {
  const r = await queryOne<{ n: string | number }>(
    `SELECT COUNT(*) AS n FROM tasks WHERE user_id = $1 AND done = FALSE AND due_at IS NOT NULL AND due_at < $2`,
    [dataId, now.toISOString()]
  ).catch(() => null);
  return Number(r?.n ?? 0);
}
