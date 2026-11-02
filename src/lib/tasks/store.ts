import { query, queryOne } from "@/lib/dsql";
import { emitEvent } from "@/lib/events/bus";
import { keysetClause, type Cursor } from "@/lib/public-api/pagination";

/** Tasks data layer for the public API. Emits `task.created` like the in-app route. */

export interface TaskRow {
  id: string;
  title: string;
  done: boolean;
  chat_id: string | null;
  created_at: string | Date;
}

export interface TaskDTO {
  id: string;
  title: string;
  done: boolean;
  chat_id: string | null;
  created_at: string;
}

const COLS = "id::text AS id, title, done, chat_id::text AS chat_id, created_at";

export function toTaskDTO(r: TaskRow): TaskDTO {
  return {
    id: String(r.id),
    title: r.title,
    done: Boolean(r.done),
    chat_id: r.chat_id,
    created_at: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
  };
}

export async function listTasks(dataId: string, opts: { done?: boolean | null; limit?: number; cursor?: Cursor | null } = {}): Promise<TaskDTO[]> {
  const params: unknown[] = [dataId];
  let sql = `SELECT ${COLS} FROM tasks WHERE user_id = $1`;
  if (opts.done === true || opts.done === false) {
    params.push(opts.done);
    sql += ` AND done = $${params.length}`;
  }
  sql += keysetClause(opts.cursor, params);
  params.push(Math.min(Math.max(opts.limit ?? 50, 1), 500));
  sql += ` ORDER BY created_at DESC, id DESC LIMIT $${params.length}`;
  return (await query<TaskRow>(sql, params)).map(toTaskDTO);
}

export async function getTask(dataId: string, id: string): Promise<TaskDTO | null> {
  const row = await queryOne<TaskRow>(`SELECT ${COLS} FROM tasks WHERE id::text = $1 AND user_id = $2`, [id, dataId]);
  return row ? toTaskDTO(row) : null;
}

export async function createTask(dataId: string, input: { title: string }): Promise<TaskDTO> {
  const row = await queryOne<TaskRow>(`INSERT INTO tasks (user_id, title) VALUES ($1, $2) RETURNING ${COLS}`, [dataId, input.title.trim()]);
  if (!row) throw new Error("Insert returned no row");
  void emitEvent(dataId, { type: "task.created", entity: "task", entityId: String(row.id), data: { title: row.title, source: "api" } });
  return toTaskDTO(row);
}

export async function updateTask(dataId: string, id: string, patch: { title?: string; done?: boolean }): Promise<TaskDTO> {
  const sets: string[] = [];
  const params: unknown[] = [id, dataId];
  if (patch.title !== undefined) {
    params.push(patch.title.trim());
    sets.push(`title = $${params.length}`);
  }
  if (patch.done !== undefined) {
    params.push(patch.done);
    sets.push(`done = $${params.length}`);
  }
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
