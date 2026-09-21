import { query, queryOne } from "@/lib/dsql";
import type { PlaybookDef } from "./types";

type Card = { id: string; title: string; status: string; priority: string; due_date: string | null; assignee: string | null; description: string | null };

/** Status ids conventionally used for a finished column. Board columns are user-defined, so this is a heuristic. */
const DONE_STATUSES = ["done", "complete", "completed", "published", "shipped", "archived"];

/**
 * production_tasks past due_date and not in a done column.
 * Columns used: due_date (DATE), status (column id) — aws/schema.sql + migrations.
 */
export const overdueCard: PlaybookDef = {
  id: "overdue-card",
  name: "Overdue production card",
  description: "Spots kanban cards past their due date that are still open and nudges the owner.",
  eventTypes: ["production.card.moved"],
  cooldownHours: 24,
  defaultTools: ["production.list_cards", "production.move_card", "comms.notify"],
  async detect(userId) {
    const rows = await query<{ id: string }>(
      `SELECT id FROM production_tasks
       WHERE user_id = $1 AND due_date IS NOT NULL AND due_date < CURRENT_DATE
         AND LOWER(status) <> ALL($2::text[])
       ORDER BY due_date ASC LIMIT 25`,
      [userId, DONE_STATUSES]
    ).catch(() => []);
    return rows.map((r) => r.id);
  },
  async buildPrompt(userId, entityId) {
    const c = await queryOne<Card>(
      `SELECT id, title, status, priority, due_date, assignee, description FROM production_tasks WHERE id = $1 AND user_id = $2`,
      [entityId, userId]
    ).catch(() => null);
    if (!c) return `Card ${entityId} no longer exists; do nothing and finish.`;
    return [
      `Production card "${c.title}" (id ${c.id}) was due ${c.due_date} and is still in column "${c.status}".`,
      `Priority: ${c.priority}. Assignee: ${c.assignee ?? "unassigned"}.`,
      c.description ? `Description: ${c.description.slice(0, 600)}` : "",
      "",
      "1. Use production.list_cards to see the board and whether this card is blocked by others.",
      "2. Notify the owner/assignee with comms.notify: what is overdue, by how many days, and a suggested next step.",
      "3. Only propose production.move_card if the card is clearly finished or clearly needs to go back a column; explain why.",
    ].filter(Boolean).join("\n");
  },
};
