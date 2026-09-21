import { z } from "zod";
import { query, queryOne } from "@/lib/dsql";
import { registerTool } from "@/lib/agents/registry";
import { emitEvent } from "@/lib/events/bus";
import { getUserBoardColumns, logProductionActivity } from "@/lib/production-server";
import { colById, type BoardColumn } from "@/lib/production-board";
import type { ToolResult } from "@/lib/agents/types";

/**
 * Production board tools. A "column" is the card's `status`; the user's
 * board_configs row defines which columns exist.
 */

const CARD_COLS = "id, title, status, priority, description, due_date, tags, assignee, automation, approved_at, created_at";

interface CardRow {
  id: string;
  title: string;
  status: string;
  priority: string;
  description: string | null;
  due_date: string | null;
  tags: string | null;
  assignee: string | null;
  automation: string | null;
  approved_at: string | null;
  created_at: string;
}

const FALLBACK_COLUMNS: BoardColumn[] = [
  { id: "pending_approval", label: "Pending Approval", hitl: true, color: "#f59e0b" },
  { id: "todo", label: "To Do", hitl: false, color: "#6366f1" },
  { id: "done", label: "Done", hitl: false, color: "#22c55e" },
];

async function columnsFor(userId: string): Promise<BoardColumn[]> {
  const cols = await getUserBoardColumns(userId).catch(() => []);
  return cols.length > 0 ? cols : FALLBACK_COLUMNS;
}

/** Accept a column id or its label (case-insensitive). */
function resolveColumn(cols: BoardColumn[], ref: string): BoardColumn | undefined {
  const needle = ref.trim().toLowerCase();
  return cols.find((c) => c.id.toLowerCase() === needle) ?? cols.find((c) => c.label.toLowerCase() === needle);
}

function fail(error: string): ToolResult {
  return { ok: false, summary: error, error };
}
function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/* ---------- production.list_cards ---------- */
const ListInput = z.object({ column: z.string().max(80).optional() });
type ListInputT = z.infer<typeof ListInput>;

registerTool<ListInputT>({
  name: "production.list_cards",
  module: "production",
  description: "List production board cards (up to 25), optionally within one column (by column id or label). Also returns the board's columns.",
  input: ListInput,
  parameters: { type: "object", properties: { column: { type: "string" } } },
  scope: "read",
  preview: (i) => `List cards${i.column ? ` in ${i.column}` : ""}`,
  async run(ctx, input) {
    try {
      const cols = await columnsFor(ctx.userId);
      const params: unknown[] = [ctx.userId];
      let sql = `SELECT ${CARD_COLS} FROM production_tasks WHERE user_id = $1`;
      if (input.column) {
        const col = resolveColumn(cols, input.column);
        if (!col) return fail(`Unknown column "${input.column}". Columns: ${cols.map((c) => c.id).join(", ")}`);
        params.push(col.id);
        sql += ` AND status = $${params.length}`;
      }
      sql += ` ORDER BY created_at DESC LIMIT 25`;
      const cards = await query<CardRow>(sql, params);
      return {
        ok: true,
        data: { columns: cols.map((c) => ({ id: c.id, label: c.label, hitl: c.hitl })), cards },
        summary: `Found ${cards.length} card(s)`,
      };
    } catch (err) {
      return fail(`List failed: ${errMsg(err)}`);
    }
  },
});

/* ---------- production.create_card ---------- */
const CreateInput = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(4000).optional(),
  priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
  column_id: z.string().max(80).optional(),
});
type CreateInputT = z.infer<typeof CreateInput>;

registerTool<CreateInputT>({
  name: "production.create_card",
  module: "production",
  description: "Create a card on the production board. Defaults to the board's first column.",
  input: CreateInput,
  parameters: {
    type: "object",
    properties: {
      title: { type: "string" },
      description: { type: "string" },
      priority: { type: "string", enum: ["low", "medium", "high", "urgent"] },
      column_id: { type: "string", description: "Column id or label; defaults to the first column" },
    },
    required: ["title"],
  },
  scope: "write",
  requiresApproval: false,
  preview: (i) => `Create card "${i.title}"${i.column_id ? ` in ${i.column_id}` : ""}`,
  async run(ctx, input) {
    try {
      const cols = await columnsFor(ctx.userId);
      const col = input.column_id ? resolveColumn(cols, input.column_id) : cols[0];
      if (!col) return fail(`Unknown column "${input.column_id}". Columns: ${cols.map((c) => c.id).join(", ")}`);
      const card = await queryOne<CardRow>(
        `INSERT INTO production_tasks (user_id, title, status, priority, description, tags)
         VALUES ($1,$2,$3,$4,$5,'[]') RETURNING ${CARD_COLS}`,
        [ctx.userId, input.title.trim(), col.id, input.priority ?? "medium", input.description ?? null]
      );
      if (!card) return fail("Insert returned no row");
      await logProductionActivity(ctx.userId, card.id, "created", { column: col.label, source: "agent", hitl: col.hitl }).catch(
        () => undefined
      );
      return { ok: true, data: card, summary: `Created card "${card.title}" in ${col.label}` };
    } catch (err) {
      return fail(`Create failed: ${errMsg(err)}`);
    }
  },
});

/* ---------- production.move_card ---------- */
const MoveInput = z.object({ id: z.string().min(1), to_column: z.string().min(1).max(80) });
type MoveInputT = z.infer<typeof MoveInput>;

registerTool<MoveInputT>({
  name: "production.move_card",
  module: "production",
  description: "Move a production card to another column (by column id or label).",
  input: MoveInput,
  parameters: {
    type: "object",
    properties: { id: { type: "string" }, to_column: { type: "string" } },
    required: ["id", "to_column"],
  },
  scope: "write",
  requiresApproval: false,
  preview: (i) => `Move card ${i.id} to ${i.to_column}`,
  async run(ctx, input) {
    try {
      const cols = await columnsFor(ctx.userId);
      const to = resolveColumn(cols, input.to_column);
      if (!to) return fail(`Unknown column "${input.to_column}". Columns: ${cols.map((c) => c.id).join(", ")}`);
      const before = await queryOne<{ status: string }>(`SELECT status FROM production_tasks WHERE id = $1 AND user_id = $2`, [
        input.id,
        ctx.userId,
      ]);
      if (!before) return fail("Card not found");
      const card = await queryOne<CardRow>(
        `UPDATE production_tasks SET status = $1 WHERE id = $2 AND user_id = $3 RETURNING ${CARD_COLS}`,
        [to.id, input.id, ctx.userId]
      );
      if (!card) return fail("Card not found");
      const from = colById(cols, before.status);
      await logProductionActivity(ctx.userId, card.id, "moved", { from: from?.label ?? before.status, to: to.label, source: "agent" }).catch(
        () => undefined
      );
      void emitEvent(ctx.userId, {
        type: "production.card.moved",
        entity: "production_task",
        entityId: card.id,
        data: { from: before.status, to: to.id },
      });
      return { ok: true, data: card, summary: `Moved "${card.title}" to ${to.label}` };
    } catch (err) {
      return fail(`Move failed: ${errMsg(err)}`);
    }
  },
});
