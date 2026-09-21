import { z } from "zod";
import { query, queryOne } from "@/lib/dsql";
import { registerTool } from "@/lib/agents/registry";
import { emitEvent } from "@/lib/events/bus";
import type { ToolResult } from "@/lib/agents/types";

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
});
type CreateInputT = z.infer<typeof CreateInput>;

registerTool<CreateInputT>({
  name: "tasks.create",
  module: "tasks",
  description: "Create a to-do task. `due` (ISO date) is appended to the title since tasks have no due column.",
  input: CreateInput,
  parameters: {
    type: "object",
    properties: { title: { type: "string" }, due: { type: "string", description: "ISO date, optional" } },
    required: ["title"],
  },
  scope: "write",
  requiresApproval: false,
  preview: (i) => `Create task "${i.title}"${i.due ? ` due ${i.due}` : ""}`,
  async run(ctx, input) {
    try {
      const title = input.due ? `${input.title.trim()} (due ${input.due})`.slice(0, 200) : input.title.trim();
      const row = await queryOne<TaskRow>(
        `INSERT INTO tasks (user_id, title) VALUES ($1, $2) RETURNING id, title, done, created_at`,
        [ctx.userId, title]
      );
      if (!row) return fail("Insert returned no row");
      void emitEvent(ctx.userId, { type: "task.created", entity: "task", entityId: row.id, data: { title: row.title, source: "tool" } });
      return { ok: true, data: row, summary: `Created task "${row.title}"` };
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
