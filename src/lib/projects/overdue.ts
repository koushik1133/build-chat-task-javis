import { query } from "@/lib/dsql";
import { emitEvent } from "@/lib/events/bus";

export interface OverdueSweepResult {
  scanned: number;
  notified: number;
}

/**
 * Bounded, idempotent sweep: open tasks past `due_at` that have not been
 * flagged yet get `overdue_notified_at` stamped and emit `task.overdue` once.
 * The UPDATE carries the same predicate as the SELECT so two concurrent ticks
 * cannot both emit for the same task. Safe to call from every cron tick.
 */
export async function markOverdueTasks(limit = 200, now = new Date()): Promise<OverdueSweepResult> {
  const cap = Math.min(Math.max(Math.floor(limit), 1), 1000);
  const nowIso = now.toISOString();
  const due = await query<{ id: string; user_id: string }>(
    `SELECT id::text AS id, user_id FROM tasks
      WHERE done = FALSE AND deleted_at IS NULL AND due_at IS NOT NULL AND due_at < $1 AND overdue_notified_at IS NULL
      ORDER BY due_at ASC LIMIT $2`,
    [nowIso, cap]
  );
  const out: OverdueSweepResult = { scanned: due.length, notified: 0 };
  for (const row of due) {
    const flipped = await query<{ id: string; title: string; project_id: string | null; assignee_id: string | null; due_at: string | Date; priority: string | null }>(
      `UPDATE tasks SET overdue_notified_at = $2
        WHERE id::text = $1 AND done = FALSE AND overdue_notified_at IS NULL
        RETURNING id::text AS id, title, project_id, assignee_id, due_at, priority`,
      [row.id, nowIso]
    );
    const t = flipped[0];
    if (!t) continue;
    out.notified++;
    await emitEvent(row.user_id, {
      type: "task.overdue",
      entity: "task",
      entityId: t.id,
      data: { title: t.title, project_id: t.project_id, assignee_id: t.assignee_id, member_id: t.assignee_id, due_at: t.due_at instanceof Date ? t.due_at.toISOString() : String(t.due_at), priority: t.priority },
    });
  }
  return out;
}
