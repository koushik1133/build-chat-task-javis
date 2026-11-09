import { z } from "zod";
import { query, queryOne } from "@/lib/dsql";
import { registerTool } from "@/lib/agents/registry";
import type { ToolResult } from "@/lib/agents/types";
import { createTask, TASK_PRIORITIES } from "@/lib/tasks/store";

/** Personal to-do list tools (the `tasks` table). */

interface TaskRow {
  id: string;
  title: string;
  done: boolean;
  created_at: string;
}

function fail(error: string): ToolResult {
  return { ok: false, summary: error, error };
}
function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/* ---------- tasks.list ---------- */
const ListInput = z.object({ include_done: z.boolean().optional() });
type ListInputT = z.infer<typeof ListInput>;

registerTool<ListInputT>({
  name: "tasks.list",
  module: "tasks",
  description: "List the user's to-do tasks (open ones by default, up to 25).",
  input: ListInput,
  parameters: { type: "object", properties: { include_done: { type: "boolean" } } },
  scope: "read",
  preview: (i) => `List ${i.include_done ? "all" : "open"} tasks`,
  async run(ctx, input) {
    try {
      const rows = await query<TaskRow>(
        `SELECT id, title, done, created_at FROM tasks
         WHERE user_id = $1 ${input.include_done ? "" : "AND done = FALSE"}
         ORDER BY created_at DESC LIMIT 25`,
        [ctx.userId]
      );
      return { ok: true, data: rows, summary: `Found ${rows.length} task(s)` };
    } catch (err) {
      return fail(`List failed: ${errMsg(err)}`);
    }
  },
});

/* ---------- tasks.create ---------- */
const CreateInput = z.object({
  title: z.string().min(1).max(200),
  due: z.string().max(40).optional(),
  assignee_id: z.string().max(100).optional(),
  priority: z.enum(TASK_PRIORITIES).optional(),
});
type CreateInputT = z.infer<typeof CreateInput>;

registerTool<CreateInputT>({
  name: "tasks.create",
  module: "tasks",
  description: "Create a to-do task with an optional due date-time (ISO 8601), assignee (member user id) and priority (low|normal|high|urgent).",
  input: CreateInput,
  parameters: {
    type: "object",
    properties: {
      title: { type: "string" },
      due: { type: "string", description: "ISO date or date-time, optional (a bare date is due at end of that day UTC)" },
      assignee_id: { type: "string", description: "Member user id, optional" },
      priority: { type: "string", enum: ["low", "normal", "high", "urgent"], description: "Default normal" },
    },
    required: ["title"],
  },
  scope: "write",
  requiresApproval: false,
  preview: (i) => `Create task "${i.title}"${i.due ? ` due ${i.due}` : ""}${i.priority && i.priority !== "normal" ? ` (${i.priority})` : ""}`,
  async run(ctx, input) {
    try {
      let dueAt: string | null = null;
      if (input.due) {
        const raw = /^\d{4}-\d{2}-\d{2}$/.test(input.due) ? `${input.due}T23:59:59Z` : input.due;
        const d = new Date(raw);
        if (Number.isNaN(d.getTime())) return fail("`due` must be an ISO date or date-time");
        dueAt = d.toISOString();
      }
      const task = await createTask(ctx.userId, { title: input.title, due_at: dueAt, assignee_id: input.assignee_id ?? null, priority: input.priority ?? "normal" }, "tool");
      return { ok: true, data: task, summary: `Created task "${task.title}"${task.due_at ? ` due ${task.due_at.slice(0, 10)}` : ""}` };
    } catch (err) {
      return fail(`Create failed: ${errMsg(err)}`);
    }
  },
});

/* ---------- tasks.complete ---------- */
const CompleteInput = z.object({ id: z.string().min(1) });
type CompleteInputT = z.infer<typeof CompleteInput>;

registerTool<CompleteInputT>({
  name: "tasks.complete",
  module: "tasks",
  description: "Mark a to-do task as done.",
  input: CompleteInput,
  parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  scope: "write",
  requiresApproval: false,
  preview: (i) => `Complete task ${i.id}`,
  async run(ctx, input) {
    try {
      const row = await queryOne<TaskRow>(
        `UPDATE tasks SET done = TRUE WHERE id = $1 AND user_id = $2 RETURNING id, title, done, created_at`,
        [input.id, ctx.userId]
      );
      if (!row) return fail("Task not found");
      return { ok: true, data: row, summary: `Completed "${row.title}"` };
    } catch (err) {
      return fail(`Update failed: ${errMsg(err)}`);
    }
  },
});
